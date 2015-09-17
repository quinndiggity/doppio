import ClassData = require('./ClassData');
import ClassLoader = require('./ClassLoader');
import methods = require('./methods');
import enums = require('./enums');
import assert = require('./assert');
import gLong = require('./gLong');
import opcodes = require('./opcodes');
import attributes = require('./attributes');
import logging = require('./logging');
import JVM = require('./jvm');
import util = require('./util');
import ConstantPool = require('./ConstantPool');
import JVMTypes = require('../includes/JVMTypes');
import Monitor = require('./Monitor');

declare var RELEASE: boolean;

var debug = logging.debug, vtrace = logging.vtrace, trace = logging.trace,
  // The number of method resumes we should allow before yielding for
  // responsiveness. Updated using a cumulative moving average to ensure
  // Doppio is responsive.
  maxMethodResumes: number = 10000,
  // The number of method resumes until Doppio should yield again.
  methodResumesLeft: number = maxMethodResumes,
  // How responsive Doppio should aim to be, in milliseconds.
  responsiveness: number = 1000,
  // Used for the CMA.
  numSamples: number = 1;

/**
 * Represents a stack frame.
 */
export interface IStackFrame {
  /**
   * Runs or resumes the method, as configured.
   */
  run: (thread: JVMThread) => void;
  /**
   * Configures the method to resume after a method call.
   * @rv The return value from the method call, if applicable.
   * @rv2 The second return value, which will always be null if applicable.
   */
  scheduleResume: (thread: JVMThread, rv?: any, rv2?: any) => void;
  /**
   * Checks if the method can handle the given exception. If so,
   * configures the stack frame to handle the exception.
   * @return True if the method can handle the exception.
   */
  scheduleException: (thread: JVMThread, e: JVMTypes.java_lang_Throwable) => boolean;
  /**
   * This stack frame's type.
   */
  type: enums.StackFrameType;
  /**
   * Retrieve a stack trace frame from this stack trace. If this stack frame
   * should not be language-visible, return null.
   */
  getStackTraceFrame(): IStackTraceFrame;
}

/**
 * Represents a stack frame for a bytecode method.
 */
export class BytecodeStackFrame implements IStackFrame {
  public pc: number = 0;
  public locals: any[];
  public stack: any[] = [];
  public returnToThreadLoop: boolean = false;
  public lockedMethodLock: boolean = false;
  public method: methods.Method;

  /**
   * Constructs a bytecode method's stack frame.
   * @param method The bytecode method to run.
   * @param args The arguments to pass to the bytecode method.
   */
  constructor(method: methods.Method, args: any[]) {
    this.method = method;
    assert(!method.accessFlags.isNative(), 'Cannot run a native method using a BytecodeStackFrame.');
    // @todo This should be a runtime error, since reflection can cause you to
    // try to do this.
    assert(!method.accessFlags.isAbstract(), 'Cannot run an abstract method!');
    this.locals = args;
  }

  public run(thread: JVMThread): void {
    var method = this.method, code = this.method.getCodeAttribute().getCode(),
      opcodeTable = opcodes.LookupTable;
    if (this.pc === 0) {
      trace(`\nT${thread.getRef()} D${thread.getStackTrace().length} Running ${this.method.getFullSignature()} [Bytecode]:`);
    } else {
      trace(`\nT${thread.getRef()} D${thread.getStackTrace().length} Resuming ${this.method.getFullSignature()}:${this.pc} [Bytecode]:`);
    }
    vtrace(`  S: [${logging.debug_vars(this.stack)}], L: [${logging.debug_vars(this.locals)}]`);

    if (method.accessFlags.isSynchronized() && !this.lockedMethodLock) {
      // We are starting a synchronized method! These must implicitly enter
      // their respective locks.
      this.lockedMethodLock = method.methodLock(thread, this).enter(thread, () => {
        // Lock succeeded. Set the flag so we don't attempt to reacquire it
        // when this method reruns.
        this.lockedMethodLock = true;
      });
      if (!this.lockedMethodLock) {
        // Failed. Thread is automatically blocked. Return.
        assert(thread.getStatus() === enums.ThreadStatus.BLOCKED, "Failed to enter a monitor. Thread must be BLOCKED.");
        return;
      }
    }

    // Reset the returnToThreadLoop switch. The current value is leftover
    // from the previous time this method was run, and is meaningless.
    this.returnToThreadLoop = false;

    // Run until we get the signal to return to the thread loop.
    while (!this.returnToThreadLoop) {
      var op = code.readUInt8(this.pc);
      vtrace(`  ${this.pc} ${annotateOpcode(op, this, code, this.pc)}`);
      opcodeTable[op](thread, this, code, this.pc);
      if (!this.returnToThreadLoop) {
        vtrace(`    S: [${logging.debug_vars(this.stack)}], L: [${logging.debug_vars(this.locals)}]`);
      }
    }
  }

  public scheduleResume(thread: JVMThread, rv?: any, rv2?: any): void {
    // Advance to the next opcode.
    var prevOp = this.method.getCodeAttribute().getCode().readUInt8(this.pc);
    switch (prevOp) {
      case enums.OpCode.INVOKEINTERFACE:
      case enums.OpCode.INVOKEINTERFACE_FAST:
        this.pc += 5;
        break;
      case enums.OpCode.INVOKESPECIAL:
      case enums.OpCode.INVOKESTATIC:
      case enums.OpCode.INVOKEVIRTUAL:
      case enums.OpCode.INVOKESTATIC_FAST:
      case enums.OpCode.INVOKENONVIRTUAL_FAST:
      case enums.OpCode.INVOKEVIRTUAL_FAST:
      case enums.OpCode.INVOKEHANDLE:
      case enums.OpCode.INVOKEBASIC:
      case enums.OpCode.LINKTOSPECIAL:
      case enums.OpCode.LINKTOVIRTUAL:
      case enums.OpCode.INVOKEDYNAMIC:
      case enums.OpCode.INVOKEDYNAMIC_FAST:
        this.pc += 3;
        break;
      default:
        // Should be impossible.
        assert(false, `Resuming from a non-invoke opcode! Opcode: ${enums.OpCode[prevOp]} [${prevOp}]`);
        break;
    }

    if (rv !== undefined) {
      this.stack.push(rv);
    }
    if (rv2 !== undefined) {
      this.stack.push(rv2);
    }
  }

  /**
   * Checks if this method can handle the specified exception 'e'.
   * Returns true if it can, or if it needs to asynchronously resolve some
   * classes.
   *
   * In the latter case, scheduleException will handle rethrowing the exception
   * in the event that it can't actually handle it.
   */
  public scheduleException(thread: JVMThread, e: JVMTypes.java_lang_Throwable): boolean {
    var codeAttr = this.method.getCodeAttribute(),
      pc = this.pc, method = this.method,
      // STEP 1: See if we can find an appropriate handler for this exception!
      exceptionHandlers = codeAttr.exceptionHandlers,
      ecls = e.getClass(), handler: attributes.ExceptionHandler, i: number;
    for (i = 0; i < exceptionHandlers.length; i++) {
      var eh = exceptionHandlers[i];
      if (eh.startPC <= pc && pc < eh.endPC) {
        if (eh.catchType === "<any>") {
          handler = eh;
          break;
        } else {
          var resolvedCatchType = method.cls.getLoader().getResolvedClass(eh.catchType);
          if (resolvedCatchType != null) {
            if (ecls.isCastable(resolvedCatchType)) {
              handler = eh;
              break;
            }
          } else {
            // ASYNC PATH: We'll need to asynchronously resolve these handlers.
            debug(`${method.getFullSignature()} needs to resolve some exception types...`);
            var handlerClasses: string[] = [];
            exceptionHandlers.forEach((handler: attributes.ExceptionHandler) => {
              if (handler.catchType !== "<any>") {
                handlerClasses.push(handler.catchType);
              }
            });
            debug(`${method.getFullSignature()}: Has to resolve exception classes. Deferring scheduling...`);
            thread.setStatus(enums.ThreadStatus.ASYNC_WAITING);
            method.cls.getLoader().resolveClasses(thread, handlerClasses, (classes: { [name: string]: ClassData.ClassData; }) => {
              if (classes !== null) {
                debug(`${method.getFullSignature()}: Rethrowing exception to handle!`);
                // Rethrow the exception to trigger scheduleException again.
                // @todo If the ClassLoader throws an exception during resolution,
                // this could result in an infinite loop. Fix would be to sync check
                // if class failed to load previously.
                thread.throwException(e);
              }
            });
            // Tell the thread we'll handle it.
            return true;
          }
        }
      }
    }

    // STEP 2: Either continue on if we could not find an appropriate handler,
    // or set up the stack for appropriate resumption.
    if (handler != null) {
      // Found the handler.
      debug(`${method.getFullSignature()}: Caught ${e.getClass().getInternalName()} as subclass of ${handler.catchType}`);
      this.stack = [e]; // clear out anything on the stack; it was made during the try block
      this.pc = handler.handlerPC;
      return true;
    } else {
      // abrupt method invocation completion
      debug(`${method.getFullSignature()}: Did not catch ${e.getClass().getInternalName()}.`);
      // STEP 3: Synchronized method? Exit from the method's monitor.
      if (method.accessFlags.isSynchronized()) {
        method.methodLock(thread, this).exit(thread);
      }
      return false;
    }
  }

  /**
   * Returns the classloader for the stack frame.
   */
  public getLoader(): ClassLoader.ClassLoader {
    return this.method.cls.getLoader();
  }

  /**
   * Indicates the type of this stack frame.
   */
  public type: enums.StackFrameType = enums.StackFrameType.BYTECODE;

  public getStackTraceFrame(): IStackTraceFrame {
    return {
      method: this.method,
      pc: this.pc,
      stack: this.stack.slice(0),
      locals: this.locals.slice(0)
    };
  }
}

/**
 * Represents a native method's stack frame.
 */
export class NativeStackFrame implements IStackFrame {
  private nativeMethod: Function;
  public method: methods.Method;
  private args: any[];

  /**
   * Constructs a native method's stack frame.
   * @param method The native method to run.
   * @param args The arguments to pass to the native method.
   */
  constructor(method: methods.Method, args: any[]) {
    this.method = method;
    this.args = args;
    assert(method.accessFlags.isNative());
    this.nativeMethod = method.getNativeFunction();
  }

  /**
   * Calls the native method.
   * NOTE: Should only be called once.
   */
  public run(thread: JVMThread): void {
    trace(`\nT${thread.getRef()} D${thread.getStackTrace().length} Running ${this.method.getFullSignature()} [Native]:`);
    var rv: any = this.nativeMethod.apply(null, this.method.convertArgs(thread, this.args));
    // Ensure thread is running, and we are the running method.
    if (thread.getStatus() === enums.ThreadStatus.RUNNING && thread.currentMethod() === this.method) {
      // Normal native method exit.
      var returnType = this.method.returnType;
      switch (returnType) {
        case 'J':
        case 'D':
          // Two stack return values for methods that return a long or a double.
          thread.asyncReturn(rv, null);
          break;
        case 'Z':
          // Convert to a number.
          thread.asyncReturn(rv ? 1 : 0);
          break;
        default:
          thread.asyncReturn(rv);
          break;
      }
    }
  }

  /**
   * N/A
   */
  public scheduleResume(thread: JVMThread, rv?: any, rv2?: any): void {
    // NOP
  }

  /**
   * Not relevant; the first execution block of a native method will never
   * receive an exception.
   */
  public scheduleException(thread: JVMThread, e: JVMTypes.java_lang_Throwable): boolean {
    return false;
  }

  public type: enums.StackFrameType = enums.StackFrameType.NATIVE;

  public getStackTraceFrame(): IStackTraceFrame {
    return {
      method: this.method,
      pc: -1,
      stack: [],
      locals: []
    };
  }
}

/**
 * InternalStackFrames are used by the JVM to launch JVM functions that
 * eventually call back into JavaScript code when they complete or throw a
 * fatal exception.
 */
export class InternalStackFrame implements IStackFrame {
  private isException: boolean = false;
  private val: any;
  private cb: (e?: JVMTypes.java_lang_Throwable, rv?: any) => void;

  /**
   * @param cb Callback function. Called with an exception if one occurs, or
   *   the return value from the called method, if relevant.
   */
  constructor(cb: (e?: JVMTypes.java_lang_Throwable, rv?: any) => void) {
    this.cb = cb;
  }

  public run(thread: JVMThread): void {
    // Pop myself off of the stack.
    thread.framePop();
    // Pause the thread before returning into native JavaScript code.
    thread.setStatus(enums.ThreadStatus.ASYNC_WAITING);
    if (this.isException) {
      this.cb(this.val);
    } else {
      this.cb(null, this.val);
    }
  }

  /**
   * Resumes the JavaScript code that created this stack frame.
   */
  public scheduleResume(thread: JVMThread, rv?: any): void {
    this.isException = false;
    this.val = rv;
  }

  /**
   * Resumes the JavaScript code that created this stack frame with the given
   * exception.
   */
  public scheduleException(thread: JVMThread, e: JVMTypes.java_lang_Throwable): boolean {
    this.isException = true;
    this.val = e;
    return true;
  }

  public type: enums.StackFrameType = enums.StackFrameType.INTERNAL;

  public getStackTraceFrame(): IStackTraceFrame {
    // These should not be language visible.
    return null;
  }
}

/**
 * Represents the JVM thread pool. Handles scheduling duties.
 */
export class ThreadPool {
  private threads: JVMThread[] = [];
  private runningThread: JVMThread;
  private runningThreadIndex: number = -1;
  private parkCounts: { [threadRef: number]: number } = {};
  /**
   * Called when the ThreadPool becomes empty. This is usually a sign that
   * execution has finished, and the JVM should be terminated.
   */
  private emptyCallback: () => void;
  private jvm: JVM;
  private bsCl: ClassLoader.BootstrapClassLoader;
  private inShutdownSequence: boolean;

  constructor(jvm: JVM, bsCl: ClassLoader.BootstrapClassLoader,
    emptyCallback: () => void) {
    this.jvm = jvm;
    this.bsCl = bsCl;
    this.emptyCallback = emptyCallback;
  }

  public getThreads(): JVMThread[] {
    // Return a copy of our internal array.
    return this.threads.slice(0);
  }

  private addThread(thread: JVMThread): void {
    if (this.threads.indexOf(thread) === -1) {
      this.threads.push(thread);
    }
  }

  public newThread(threadObj: JVMTypes.java_lang_Thread): JVMThread {
    var thread = new JVMThread(this.bsCl, this, threadObj);
    this.addThread(thread);
    return thread;
  }

  /**
   * Resurrects a previously-terminated thread.
   */
  public resurrectThread(thread: JVMThread): void {
    this.addThread(thread);
  }

  public getJVM(): JVM {
    return this.jvm;
  }

  /**
   * Schedules and runs the next thread.
   */
  private scheduleNextThread(): void {
    // Reset stack depth, start at beginning of new JS event.
    setImmediate(() => {
      var i: number, iFixed: number, threads = this.threads, thread: JVMThread;
      if (this.runningThread == null) {
        for (i = 0; i < threads.length; i++) {
          // Cycle through the threads, starting at the thread just past the
          // previously-run thread. (Round Robin scheduling algorithm)
          iFixed = (this.runningThreadIndex + 1 + i) % threads.length;
          thread = threads[iFixed];
          if (thread.getStatus() === enums.ThreadStatus.RUNNABLE) {
            this.runningThread = thread;
            this.runningThreadIndex = iFixed;
            thread.setStatus(enums.ThreadStatus.RUNNING);
            break;
          }
        }
        // This search is allowed to fail. In fact, it _must_ fail to allow
        // async events to occur outside the JVM.
      }
    });
  }

  public threadRunnable(thread: JVMThread): void {
    // We only care if no threads are running right now.
    if (this.runningThread == null) {
      this.scheduleNextThread();
    }
  }

  /**
   * Checks if any remaining threads are non-daemonic and could be runnable.
   * If not, we can terminate execution.
   */
  private anySchedulableThreads(thread: JVMThread): boolean {
    var i: number, t: JVMThread, status: enums.ThreadStatus;
    for (i = 0; i < this.threads.length; i++) {
      t = this.threads[i];
      if (t.getJVMObject()['java/lang/Thread/daemon'] != 0) {
        continue;
      }
      status = t.getStatus();
      if (status != enums.ThreadStatus.NEW &&
          status != enums.ThreadStatus.TERMINATED) {
        return true;
      }
    }
    return false;
  }

  public threadTerminated(thread: JVMThread): void {
    var idx: number = this.threads.indexOf(thread);
    assert(idx >= 0);
    // Remove the specified thread from the threadpool.
    this.threads.splice(idx, 1);

    // If this was the running thread, schedule a new one to run.
    if (this.runningThread === thread) {
      this.runningThread = null;
      // The runningThreadIndex is currently pointing to the *next* thread we
      // should schedule, so take it back by one.
      this.runningThreadIndex = this.runningThreadIndex - 1;
      if (this.anySchedulableThreads(thread)) {
        this.scheduleNextThread();
      } else if (!this.jvm.isShutdown()) {
        // Start the manual shutdown sequence.
        // XXX: we're co-opting the last thread for shutdown.
        var cdata = <ClassData.ReferenceClassData<JVMTypes.java_lang_System>> this.bsCl.getInitializedClass(thread, "Ljava/lang/System;"),
          systemCons = <typeof JVMTypes.java_lang_System> cdata.getConstructor(thread);
        systemCons['java/lang/System/exit(I)V'](thread, [0]);
      } else {
        // Tell the JVM that execution is over.
        this.emptyCallback();
      }
    } else {
      // Update the index so it still points to the running thread.
      this.runningThreadIndex = this.threads.indexOf(this.runningThread);
    }
  }

  public threadSuspended(thread: JVMThread): void {
    // If this was the running thread, schedule a new one to run.
    if (thread === this.runningThread) {
      this.runningThread = null;
      this.scheduleNextThread();
    }
  }

  public park(thread: JVMThread): void {
    if (!this.parkCounts.hasOwnProperty("" + thread.getRef())) {
      this.parkCounts[thread.getRef()] = 0;
    }

    if (++this.parkCounts[thread.getRef()] > 0) {
      thread.setStatus(enums.ThreadStatus.PARKED);
    }
  }

  public unpark(thread: JVMThread): void {
    if (!this.parkCounts.hasOwnProperty("" + thread.getRef())) {
      this.parkCounts[thread.getRef()] = 0;
    }

    if (--this.parkCounts[thread.getRef()] <= 0) {
      thread.setStatus(enums.ThreadStatus.RUNNABLE);
    }
  }

  public completelyUnpark(thread: JVMThread): void {
    this.parkCounts[thread.getRef()] = 0;
    thread.setStatus(enums.ThreadStatus.RUNNABLE);
  }

  public isParked(thread: JVMThread): boolean {
    return this.parkCounts[thread.getRef()] > 0;
  }
}

export interface IStackTraceFrame {
  method: methods.Method;
  pc: number;
  stack: any[];
  locals: any[];
}

/**
 * Represents a single JVM thread.
 */
export class JVMThread {
  /**
   * The current state of this thread, from the JVM level.
   */
  private status: enums.ThreadStatus = enums.ThreadStatus.NEW;

  /**
   * The call stack.
   */
  private stack: IStackFrame[] = [];

  /**
   * Whether or not this thread has been interrupted. It's a JVM thing.
   */
  private interrupted: boolean = false;

  /**
   * Immortal threads cannot be terminated. Used by the JVM during bootup
   * class initialization, before the program runs, to prevent premature
   * JVM termination.
   */
  public immortal: boolean = false;

  /**
   * If the thread is WAITING, BLOCKED, or TIMED_WAITING, this field holds the
   * monitor that is involved.
   */
  private monitor: Monitor = null;
  private bsCl: ClassLoader.BootstrapClassLoader;
  private tpool: ThreadPool;
  private jvmThreadObj: JVMTypes.java_lang_Thread;

  /**
   * Initializes a new JVM thread. Starts the thread in the NEW state.
   */
  constructor(bsCl: ClassLoader.BootstrapClassLoader, tpool: ThreadPool, threadObj: JVMTypes.java_lang_Thread) {
    this.bsCl = bsCl;
    this.tpool = tpool;
    this.jvmThreadObj = threadObj;
  }

  /**
   * Get the JVM thread object that represents this thread.
   */
  public getJVMObject(): JVMTypes.java_lang_Thread {
    return this.jvmThreadObj;
  }

  /**
   * XXX: Used during bootstrapping to set the first thread's Thread object.
   */
  public setJVMObject(obj: JVMTypes.java_lang_Thread): void {
    obj['java/lang/Thread/threadStatus'] = this.jvmThreadObj['java/lang/Thread/threadStatus'];
    this.jvmThreadObj = obj;
  }

  /**
   * Return the reference number for this thread.
   */
  public getRef(): number {
    return this.jvmThreadObj.ref;
  }

  /**
   * Check if this thread's interrupted flag is set.
   */
  public isInterrupted(): boolean {
    return this.interrupted;
  }

  /**
   * Returns the currently running method. Returns NULL if stack is empty.
   */
  public currentMethod(): methods.Method {
    var stack = this.stack, idx = stack.length, method: methods.Method;
    while (--idx >= 0) {
      method = stack[idx].getStackTraceFrame().method;
      if (method !== null) {
        return method;
      }
    }
    return null;
  }

  /**
   * Set or unset this thread's interrupted flag.
   */
  public setInterrupted(interrupted: boolean): void {
    this.interrupted = interrupted;
  }

  /**
   * Retrieve the bootstrap classloader.
   */
  public getBsCl(): ClassLoader.BootstrapClassLoader {
    return this.bsCl;
  }

  /**
   * Retrieve the thread pool that this thread belongs to.
   */
  public getThreadPool(): ThreadPool {
    return this.tpool;
  }

  /**
   * Retrieves the current stack trace.
   */
  public getStackTrace(): IStackTraceFrame[] {
    var trace: IStackTraceFrame[] = [], i: number,
      frame: IStackTraceFrame;
    for (i = 0; i < this.stack.length; i++) {
      frame = this.stack[i].getStackTraceFrame();
      if (frame != null) {
        trace.push(frame);
      }
    }
    return trace;
  }

  /**
   * [DEBUG] Return a printable string of the thread's current stack trace.
   */
  public getPrintableStackTrace(): string {
    var rv: string = "";
    this.getStackTrace().reverse().forEach((trace: IStackTraceFrame) => {
      rv += `\tat ${util.ext_classname(trace.method.cls.getInternalName())}::${trace.method.name}(`;
      if (trace.pc >= 0) {
        // Bytecode method
        var code = trace.method.getCodeAttribute();
        var table = <attributes.LineNumberTable> code.getAttribute('LineNumberTable');
        var srcAttr = <attributes.SourceFile> trace.method.cls.getAttribute('SourceFile');
        if (srcAttr != null) {
          rv += srcAttr.filename;
        } else {
          rv += 'unknown';
        }
        if (table != null) {
          var lineNumber = table.getLineNumber(trace.pc);
          rv += `:${lineNumber}`;
          rv += ` Bytecode offset: ${trace.pc}`;
        }
      } else {
        // Native method.
        rv += "native";
      }
      rv += ")\n";
    });
    return rv;
  }

  /**
   * The thread's main execution loop. Everything starts here!
   */
  private run(): void {
    var stack = this.stack,
      startTime: number = (new Date()).getTime(),
      endTime: number,
      duration: number,
      estMaxMethodResumes: number;

    // Reset counter. Threads always start from a fresh stack / yield.
    methodResumesLeft = maxMethodResumes;
    while (this.status === enums.ThreadStatus.RUNNING && stack.length > 0) {
      if (typeof RELEASE === 'undefined') {
        var sf = stack[stack.length - 1];
        if (sf.type === enums.StackFrameType.BYTECODE && this.tpool.getJVM().shouldVtrace((<BytecodeStackFrame> sf).method.fullSignature)) {
          var oldLevel = logging.log_level;
          logging.log_level = logging.VTRACE;
          stack[stack.length - 1].run(this);
          logging.log_level = oldLevel;
        } else {
          stack[stack.length - 1].run(this);
        }
      } else {
        stack[stack.length - 1].run(this);
      }
      if (--methodResumesLeft === 0) {
        endTime = (new Date()).getTime();
        duration = endTime - startTime;
        // Estimated number of methods we can resume before needing to yield.
        estMaxMethodResumes = Math.floor((maxMethodResumes / duration) * responsiveness);
        // Update CMA.
        maxMethodResumes = (estMaxMethodResumes + numSamples * maxMethodResumes) / (numSamples + 1);
        numSamples++;
        // If we're still scheduled to run, yield to the browser loop.
        // (Otherwise, we're going to yield anyway, and something else is
        // responsible for resuming us.)
        if (this.status === enums.ThreadStatus.RUNNING) {
          // Yield.
          this.setStatus(enums.ThreadStatus.ASYNC_WAITING);
          setImmediate(() => { this.setStatus(enums.ThreadStatus.RUNNABLE); });
        }
      }
    }

    if (stack.length === 0) {
      // This thread has finished!
      this.setStatus(enums.ThreadStatus.TERMINATED);
    }
  }

  /**
   * [DEBUG] Performs a sanity check on the thread.
   */
  private sanityCheck(): boolean {
    switch (this.status) {
      case enums.ThreadStatus.NEW:
        return true;
      case enums.ThreadStatus.RUNNING:
        return this.stack.length > 0;
      case enums.ThreadStatus.RUNNABLE:
        return this.stack.length > 0;
      case enums.ThreadStatus.TIMED_WAITING:
        return this.monitor != null && this.monitor.isTimedWaiting(this);
      case enums.ThreadStatus.WAITING:
        return this.monitor != null && this.monitor.isWaiting(this);
      case enums.ThreadStatus.BLOCKED:
        return this.monitor != null && this.monitor.isBlocked(this);
      case enums.ThreadStatus.ASYNC_WAITING:
        return true;
      case enums.ThreadStatus.TERMINATED:
        return true;
      case enums.ThreadStatus.PARKED:
        return this.getThreadPool().isParked(this);
      default:
        // Invalid ThreadStatus.
        return false;
    }
  }

  /**
   * Should only be called by setStatus.
   * Updates both the JVMThread object and this object.
   */
  private rawSetStatus(newStatus: enums.ThreadStatus): void {
    var jvmNewStatus: number = 0;
    this.status = newStatus;
    // Map our status value back to JVM's threadStatus value.
    // Ensures that JVM code can introspect on our threads.
    switch (newStatus) {
      case enums.ThreadStatus.NEW:
        jvmNewStatus |= enums.JVMTIThreadState.ALIVE;
        break;
      case enums.ThreadStatus.RUNNING:
      case enums.ThreadStatus.RUNNABLE:
        jvmNewStatus |= enums.JVMTIThreadState.RUNNABLE;
        break;
      case enums.ThreadStatus.BLOCKED:
      case enums.ThreadStatus.UNINTERRUPTABLY_BLOCKED:
        jvmNewStatus |= enums.JVMTIThreadState.BLOCKED_ON_MONITOR_ENTER;
        break;
      case enums.ThreadStatus.WAITING:
      case enums.ThreadStatus.ASYNC_WAITING:
      case enums.ThreadStatus.PARKED:
        jvmNewStatus |= enums.JVMTIThreadState.WAITING_INDEFINITELY;
        break;
      case enums.ThreadStatus.TIMED_WAITING:
        jvmNewStatus |= enums.JVMTIThreadState.WAITING_WITH_TIMEOUT;
        break;
      case enums.ThreadStatus.TERMINATED:
        jvmNewStatus |= enums.JVMTIThreadState.TERMINATED;
        break;
      default:
        jvmNewStatus = enums.JVMTIThreadState.RUNNABLE;
        break;
    }

    this.jvmThreadObj['java/lang/Thread/threadStatus'] = jvmNewStatus;
  }

  /**
   * Transitions the thread from one state to the next.
   */
  public setStatus(status: enums.ThreadStatus, monitor?: Monitor): void {
    function invalidTransition() {
      throw new Error(`Invalid state transition: ${enums.ThreadStatus[oldStatus]} => ${enums.ThreadStatus[status]}`);
    }

    // Ignore RUNNING => RUNNABLE transitions.
    if (this.status !== status && !(this.status === enums.ThreadStatus.RUNNING && status === enums.ThreadStatus.RUNNABLE)) {
      var oldStatus = this.status;
      // Prevent termination if immortal.
      if (this.immortal && status === enums.ThreadStatus.TERMINATED) {
        return;
      }

      vtrace(`\nT${this.getRef()} ${enums.ThreadStatus[oldStatus]} => ${enums.ThreadStatus[status]}`);
      assert(validateThreadTransition(oldStatus, status), `Invalid thread transition: ${enums.ThreadStatus[oldStatus]} => ${enums.ThreadStatus[status]}`);

      // Optimistically change state.
      this.rawSetStatus(status);
      this.monitor = null;

      /* Pre-transition actions */
      switch (oldStatus) {
        case enums.ThreadStatus.TERMINATED:
          // Resurrect thread.
          this.tpool.resurrectThread(this);
          break;
        case enums.ThreadStatus.PARKED:
          // XXX: Return from sun.misc.Unsafe.park
          this.asyncReturn();
          break;
      }

      /* Post-transition actions */
      switch (this.status) {
        case enums.ThreadStatus.RUNNABLE:
          // Tell the threadpool we're ready to run.
          this.tpool.threadRunnable(this);
          break;
        case enums.ThreadStatus.RUNNING:
          // I'm scheduled to run!
          this.run();
          break;
        case enums.ThreadStatus.TERMINATED:
          this.exit();
          break;
        case enums.ThreadStatus.BLOCKED:
        case enums.ThreadStatus.UNINTERRUPTABLY_BLOCKED:
        case enums.ThreadStatus.WAITING:
        case enums.ThreadStatus.TIMED_WAITING:
          assert(monitor != null);
          this.monitor = monitor;
          // FALL-THROUGH
        default:
          this.tpool.threadSuspended(this);
          break;
      }
    }
  }

  /**
   * Called when a thread finishes executing.
   */
  private exit(): void {
    var monitor: Monitor = this.jvmThreadObj.getMonitor(),
      phase2 = () => {
        // Notify everyone.
        monitor.notifyAll(this);
        // Exit monitor.
        monitor.exit(this);
        // Become terminated before the other threads start running.
        this.rawSetStatus(enums.ThreadStatus.TERMINATED);
        // Remove ourselves from the thread pool.
        this.tpool.threadTerminated(this);
      };

    // Revert our status to ASYNC_WAITING so we can acquire a monitor.
    this.rawSetStatus(enums.ThreadStatus.ASYNC_WAITING);

    // Acquire the monitor associated with our JavaObject.
    if (monitor.enter(this, phase2)) {
      phase2();
    }
  }

  /**
   * Get the monitor that this thread is waiting or blocked on.
   */
  public getMonitorBlock(): Monitor {
    return this.monitor;
  }

  /**
   * Get the thread's current state.
   */
  public getStatus(): enums.ThreadStatus {
    return this.status;
  }

  /**
   * Returns from the currently executing method with the given return value.
   * Used by asynchronous native methods.
   *
   * Causes the following state transition:
   * * RUNNING => RUNNABLE
   * * RUNNABLE => RUNNABLE
   * * ASYNC_WAITING => RUNNABLE
   *
   * It is not valid to call this method if the thread is in any other state.
   */
  public asyncReturn(): void;
  public asyncReturn(rv: number): void;
  public asyncReturn(rv: JVMTypes.java_lang_Object): void;
  public asyncReturn(rv: number, rv2: any): void;
  public asyncReturn(rv: gLong, rv2: any): void;
  public asyncReturn(rv?: any, rv2?: any): void {
    var stack = this.stack;
    assert(this.status === enums.ThreadStatus.RUNNING || this.status === enums.ThreadStatus.RUNNABLE || this.status === enums.ThreadStatus.ASYNC_WAITING);
    assert(typeof (rv) !== 'boolean' && rv2 == null);
    // Pop off the current method.
    var frame = stack.pop();
    if (frame.type != enums.StackFrameType.INTERNAL) {
      var frameCast = <BytecodeStackFrame> frame;
      if (frame.type === enums.StackFrameType.BYTECODE) {
        // This line will be preceded by a line that prints the method, so can be short n' sweet.
        trace(`  Returning: ${logging.debug_var(rv)}`);
      }

      trace(`\nT${this.getRef()} D${this.getStackTrace().length + 1} Returning value from ${frameCast.method.getFullSignature()} [${frameCast.method.accessFlags.isNative() ? 'Native' : 'Bytecode'}]: ${logging.debug_var(rv)}`);
      assert(validateReturnValue(this, frameCast.method,
        frameCast.method.returnType, this.bsCl,
        frameCast.method.cls.getLoader(), rv, rv2), `Invalid return value for method ${frameCast.method.getFullSignature()}`);
    }
    // Tell the top of the stack that this RV is waiting for it.
    var idx: number = stack.length - 1;
    // If idx is 0, then the thread will TERMINATE next time it enters its main
    // loop.
    if (idx >= 0) {
      stack[idx].scheduleResume(this, rv, rv2);
    }

    // Thread state transition.
    this.setStatus(enums.ThreadStatus.RUNNABLE);
  }

  /**
   * Pops the top stackframe off of the call stack.
   * WARNING: SHOULD ONLY BE CALLED BY InternalStackFrame.run()!
   */
  public framePop(): void {
    this.stack.pop();
  }

  /**
   * Throws the given JVM exception. Causes the thread to unwind the stack until
   * it can find a stack frame that can handle the exception.
   *
   * Causes the following state transition:
   * * RUNNING => RUNNABLE
   * * RUNNABLE => RUNNABLE
   * * ASYNC_WAITING => RUNNABLE
   *
   * Or, if the exception is uncaught, one of the following transitions:
   * * RUNNING => TERMINATED
   * * RUNNABLE => TERMINATED
   * * ASYNC_WAITING => TERMINATED
   *
   * It is not valid to call this method if the thread is in any other state.
   */
  public throwException(exception: JVMTypes.java_lang_Throwable): void {
    assert(this.status === enums.ThreadStatus.RUNNING || this.status === enums.ThreadStatus.RUNNABLE || this.status === enums.ThreadStatus.ASYNC_WAITING,
      `Tried to throw exception while thread was in state ${enums.ThreadStatus[this.status]}`);
    var stack = this.stack, idx: number = stack.length - 1;

    // Stack may actually be empty, so guard against this.
    if (idx >= 0) {
      // An internal stack frame cannot process its own thrown exception.
      if (stack[idx].type === enums.StackFrameType.INTERNAL) {
        stack.pop();
        idx--;
      }

      // Find a stack frame that can handle the exception.
      // Set our status *before* scheduling the exception. Some exception handlers
      // may want to do something asynchronous before resuming execution.
      this.setStatus(enums.ThreadStatus.RUNNABLE);
      while (stack.length > 0 && !stack[idx].scheduleException(this, exception)) {
        stack.pop();
        idx--;
      }
    }

    if (stack.length === 0) {
      // Uncaught exception!
      this.handleUncaughtException(exception);
    }
  }

  /**
   * Construct a new exception object of the given class with the given message.
   * Convenience function for native JavaScript code.
   * @param clsName Name of the class (e.g. "Ljava/lang/Throwable;")
   * @param msg The message to include with the exception.
   */
  public throwNewException<T extends JVMTypes.java_lang_Throwable>(clsName: string, msg: string) {
    var cls = <ClassData.ReferenceClassData<T>> this.bsCl.getInitializedClass(this, clsName),
      throwException = () => {
        var eCons = cls.getConstructor(this),
          e = new eCons(this);

        // Construct the exception, and throw it when done.
        e['<init>(Ljava/lang/String;)V'](this, [util.initString(this.bsCl, msg)], (err?: JVMTypes.java_lang_Throwable) => {
          if (err) {
            this.throwException(err);
          } else {
            this.throwException(e);
          }
        });
      };
    if (cls != null) {
      // No initialization required.
      throwException();
    } else {
      // Initialization required.
      this.setStatus(enums.ThreadStatus.ASYNC_WAITING);
      this.bsCl.initializeClass(this, clsName, (cdata: ClassData.ReferenceClassData<T>) => {
        if (cdata != null) {
          cls = cdata;
          throwException();
        }
      }, false);
    }
  }

  /**
   * Handles an uncaught exception on a thread.
   */
  public handleUncaughtException(exception: JVMTypes.java_lang_Throwable) {
    this.jvmThreadObj['dispatchUncaughtException(Ljava/lang/Throwable;)V'](this, [exception]);
  }
}

/**
 * [DEBUG] Stores all of the valid thread transitions.
 * @todo Any way to make this smaller?
 * @todo Move into 'debug' module that we NOP out in release builds.
 */
export var validTransitions: { [oldStatus: number]: { [newStatus: number]: string } } = {};
validTransitions[enums.ThreadStatus.NEW] = {};
validTransitions[enums.ThreadStatus.NEW][enums.ThreadStatus.RUNNABLE] = "RunMethod invoked on new thread";
validTransitions[enums.ThreadStatus.NEW][enums.ThreadStatus.ASYNC_WAITING] = "[JVM bootup only] Internal operation occurs on new thread";
validTransitions[enums.ThreadStatus.NEW][enums.ThreadStatus.TERMINATED] = "[JVM halt0 only] When the JVM shuts down, it terminates all threads, including those that have never been run.";
validTransitions[enums.ThreadStatus.ASYNC_WAITING] = {};
validTransitions[enums.ThreadStatus.ASYNC_WAITING][enums.ThreadStatus.RUNNABLE] = "Async operation completes";
validTransitions[enums.ThreadStatus.ASYNC_WAITING][enums.ThreadStatus.TERMINATED] = "RunMethod completes and callstack is empty";
validTransitions[enums.ThreadStatus.BLOCKED] = {};
validTransitions[enums.ThreadStatus.BLOCKED][enums.ThreadStatus.RUNNABLE] = "Acquires monitor, or is interrupted";
validTransitions[enums.ThreadStatus.PARKED] = {};
validTransitions[enums.ThreadStatus.PARKED][enums.ThreadStatus.RUNNABLE] = "Balancing unpark, or is interrupted";
validTransitions[enums.ThreadStatus.RUNNABLE] = {};
validTransitions[enums.ThreadStatus.RUNNABLE][enums.ThreadStatus.RUNNING] = "Scheduled to run";
validTransitions[enums.ThreadStatus.RUNNABLE][enums.ThreadStatus.ASYNC_WAITING] = "Scheduled to run thread performs an asynchronous JavaScript operation";
validTransitions[enums.ThreadStatus.RUNNING] = {};
validTransitions[enums.ThreadStatus.RUNNING][enums.ThreadStatus.RUNNABLE] = "[Ignored transition; stays RUNNING]";
validTransitions[enums.ThreadStatus.RUNNING][enums.ThreadStatus.ASYNC_WAITING] = "Thread performs an asynchronous JavaScript operation";
validTransitions[enums.ThreadStatus.RUNNING][enums.ThreadStatus.TERMINATED] = "Callstack is empty";
validTransitions[enums.ThreadStatus.RUNNING][enums.ThreadStatus.BLOCKED] = "Thread waits to acquire monitor";
validTransitions[enums.ThreadStatus.RUNNING][enums.ThreadStatus.WAITING] = "Thread waits on monitor (Object.wait)";
validTransitions[enums.ThreadStatus.RUNNING][enums.ThreadStatus.TIMED_WAITING] = "Thread waits on monitor with timeout (Object.wait)";
validTransitions[enums.ThreadStatus.RUNNING][enums.ThreadStatus.PARKED] = "Thread parks itself";
validTransitions[enums.ThreadStatus.TERMINATED] = {};
validTransitions[enums.ThreadStatus.TERMINATED][enums.ThreadStatus.NEW] = "Thread is resurrected for re-use";
validTransitions[enums.ThreadStatus.TERMINATED][enums.ThreadStatus.RUNNABLE] = "Thread is resurrected for re-use";
validTransitions[enums.ThreadStatus.TERMINATED][enums.ThreadStatus.ASYNC_WAITING] = "[JVM Bootup] Thread is resurrected for internal operation";
validTransitions[enums.ThreadStatus.TIMED_WAITING] = {};
validTransitions[enums.ThreadStatus.TIMED_WAITING][enums.ThreadStatus.RUNNABLE] = "Timer expires, or thread is interrupted, and thread immediately acquires lock";
validTransitions[enums.ThreadStatus.TIMED_WAITING][enums.ThreadStatus.UNINTERRUPTABLY_BLOCKED] = "Thread is interrupted or notified, or timer expires, and lock already owned";
validTransitions[enums.ThreadStatus.UNINTERRUPTABLY_BLOCKED] = {};
validTransitions[enums.ThreadStatus.UNINTERRUPTABLY_BLOCKED][enums.ThreadStatus.RUNNABLE] = "Thread acquires monitor";
validTransitions[enums.ThreadStatus.WAITING] = {};
validTransitions[enums.ThreadStatus.WAITING][enums.ThreadStatus.RUNNABLE] = "Thread is interrupted, and immediately acquires lock";
validTransitions[enums.ThreadStatus.WAITING][enums.ThreadStatus.UNINTERRUPTABLY_BLOCKED] = "Thread is notified or interrupted, and does not immediately acquire lock";

/**
 * [DEBUG] Ensures that a thread transition is legal.
 */
function validateThreadTransition(oldStatus: enums.ThreadStatus, newStatus: enums.ThreadStatus): boolean {
  var rv = validTransitions.hasOwnProperty("" + oldStatus) &&
    validTransitions[oldStatus].hasOwnProperty("" + newStatus);
  return rv;
}

/**
 * [DEBUG] Asserts that the return value of the function passes basic sanity
 * checks.
 */
function validateReturnValue(thread: JVMThread, method: methods.Method, returnType: string, bsCl: ClassLoader.BootstrapClassLoader, cl: ClassLoader.ClassLoader, rv1: any, rv2: any): boolean {
  // invokeBasic is typed with an Object return value, but it can return any
  // damn type it wants, primitive or no.
  if (method.fullSignature === "java/lang/invoke/MethodHandle/invokeBasic([Ljava/lang/Object;)Ljava/lang/Object;") {
    return true;
  }

  var cls: ClassData.ClassData;
  if (util.is_primitive_type(returnType)) {
    switch (returnType) {
      case 'Z': // Boolean
        assert(rv2 === undefined, "Second return value must be undefined for Boolean type.");
        assert(rv1 === 1 || rv1 === 0, "Booleans must be 0 or 1.");
        break;
      case 'B': // Byte
        assert(rv2 === undefined, "Second return value must be undefined for Byte type.");
        assert(rv1 <= 127 && rv1 >= -128, `Byte value for method ${method.name} is out of bounds: ${rv1}`);
        break;
      case 'C':
        assert(rv2 === undefined, "Second return value must be undefined for Character type.");
        assert(rv1 <= 65535 && rv1 >= 0, `Character value is out of bounds: ${rv1}`);
        break;
      case 'S':
        assert(rv2 === undefined, "Second return value must be undefined for Short type.");
        assert(rv1 <= 32767 && rv1 >= -32768, `Short value is out of bounds: ${rv1}`);
        break;
      case 'I': // int
        assert(rv2 === undefined, "Second return value must be undefined for Int type.");
        assert(rv1 <= 2147483647 && rv1 >= -2147483648, `Int value is out of bounds: ${rv1}`);
        break;
      case 'J': // long //-9223372036854775808 to 9223372036854775807
        assert(rv2 === null, "Second return value must be NULL for Long type.");
        assert((<gLong> rv1).lessThanOrEqual(gLong.MAX_VALUE) && (<gLong> rv1).greaterThanOrEqual(gLong.MIN_VALUE), `Long value is out of bounds: ${rv1}`);
        break;
      case 'F': // Float
        assert(rv2 === undefined, "Second return value must be undefined for Float type.");
        // NaN !== NaN, so we have to have a special case here.
        assert(util.wrapFloat(rv1) === rv1 || (isNaN(rv1) && isNaN(util.wrapFloat(rv1))), `Float value is out of bounds: ${rv1}`);
        break;
      case 'D': // Double
        assert(rv2 === null, "Second return value must be NULL for Double type.");
        assert(typeof rv1 === 'number', `Invalid double value: ${rv1}`);
        break;
      case 'V':
        assert(rv1 === undefined && rv2 === undefined, "Return values must be undefined for Void type");
        break;
    }
  } else if (util.is_array_type(returnType)) {
    assert(rv2 === undefined, "Second return value must be undefined for array type.");
    assert(rv1 === null || (typeof rv1 === 'object' && typeof rv1['getClass'] === 'function'), `Invalid array object: ${rv1}`);
    if (rv1 != null) {
      cls = cl.getInitializedClass(thread, returnType);
      if (cls === null) {
        cls = bsCl.getInitializedClass(thread, returnType);
      }
      assert(cls != null, `Unable to get class for ${returnType}.`);
      assert(rv1.getClass().isCastable(cls), `Return value of type ${rv1.getClass().getInternalName()} unable to be cast to return type ${returnType}.`);
    }
  } else {
    assert(util.is_reference_type(returnType), `Invalid reference type: ${returnType}`);
    assert(rv2 === undefined, `Second return value must be undefined for reference type.`);
    // All objects and arrays are instances of java/lang/Object.
    assert(rv1 === null || rv1 instanceof (<ClassData.ReferenceClassData<JVMTypes.java_lang_Object>> bsCl.getInitializedClass(thread, 'Ljava/lang/Object;')).getConstructor(thread), `Reference return type must be an instance of Object; value: ${rv1}`);
    if (rv1 != null) {
      cls = null;
      var tempCl: ClassLoader.ClassLoader = cl;
      // Search classloader hierarchy for class; ensure it is resolved.
      while (cls === null) {
        cls = tempCl.getResolvedClass(returnType);
        if (tempCl.getLoaderObject() !== null) {
          if (tempCl.getLoaderObject()['java/lang/ClassLoader/parent'] === null) {
            tempCl = bsCl;
          } else {
            tempCl = tempCl.getLoaderObject()['java/lang/ClassLoader/parent'].$loader;
          }
        } else {
          assert(cls !== null, `Unable to get resolved class for type ${returnType}.`);
        }
      }
      if (!cls.accessFlags.isInterface()) {
        // You can return an interface type without initializing it,
        // since they don't need to be initialized until you try to
        // invoke one of their methods.
        // NOTE: We don't check if the class is in the INITIALIZED state,
        // since it is possible that it is currently in th process of being
        // initialized. getInitializedClass handles this subtlety.
        tempCl = cl;
        cls = null;
        while (cls === null) {
          cls = tempCl.getInitializedClass(thread, returnType);
          if (tempCl.getLoaderObject() !== null) {
            if (tempCl.getLoaderObject()['java/lang/ClassLoader/parent'] === null) {
              tempCl = bsCl;
            } else {
              tempCl = tempCl.getLoaderObject()['java/lang/ClassLoader/parent'].$loader;
            }
          } else {
            assert(cls !== null, `Unable to get initialized class for type ${returnType}.`);
          }
        }
      }
      assert(rv1.getClass().isCastable(cls), `Unable to cast ${rv1.getClass().getInternalName()} to ${returnType}.`);
    }
  }
  return true;
}

function printConstantPoolItem(cpi: ConstantPool.IConstantPoolItem): string {
  switch (cpi.getType()) {
    case enums.ConstantPoolItemType.METHODREF:
      var cpiMR = <ConstantPool.MethodReference> cpi;
      return util.ext_classname(cpiMR.classInfo.name) + "." + cpiMR.signature;
    case enums.ConstantPoolItemType.INTERFACE_METHODREF:
      var cpiIM = <ConstantPool.InterfaceMethodReference> cpi;
      return util.ext_classname(cpiIM.classInfo.name) + "." + cpiIM.signature;
    case enums.ConstantPoolItemType.FIELDREF:
      var cpiFR = <ConstantPool.FieldReference> cpi;
      return util.ext_classname(cpiFR.classInfo.name) + "." + cpiFR.nameAndTypeInfo.name + ":" + util.ext_classname(cpiFR.nameAndTypeInfo.descriptor);
    case enums.ConstantPoolItemType.NAME_AND_TYPE:
      var cpiNAT = <ConstantPool.NameAndTypeInfo> cpi;
      return cpiNAT.name + ":" + cpiNAT.descriptor;
    case enums.ConstantPoolItemType.CLASS:
      var cpiClass = <ConstantPool.ClassReference> cpi;
      return util.ext_classname(cpiClass.name);
    default:
      return logging.debug_var((<any> cpi).value);
  }
}

// TODO: Prefix behind DEBUG, cache lowercase opcode names.
export var OpcodeLayoutPrinters: {[layoutAtom: number]: (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => string} = {};
OpcodeLayoutPrinters[enums.OpcodeLayoutType.OPCODE_ONLY] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase();
OpcodeLayoutPrinters[enums.OpcodeLayoutType.CONSTANT_POOL] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + printConstantPoolItem(frame.method.cls.constantPool.get(code.readUInt16BE(pc + 1)));
OpcodeLayoutPrinters[enums.OpcodeLayoutType.CONSTANT_POOL_UINT8] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + printConstantPoolItem(frame.method.cls.constantPool.get(code.readUInt8(pc + 1)));
OpcodeLayoutPrinters[enums.OpcodeLayoutType.CONSTANT_POOL_AND_UINT8_VALUE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + printConstantPoolItem(frame.method.cls.constantPool.get(code.readUInt16BE(pc + 1))) + " " + code.readUInt8(pc + 3);
OpcodeLayoutPrinters[enums.OpcodeLayoutType.UINT8_VALUE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + code.readUInt8(pc + 1);
OpcodeLayoutPrinters[enums.OpcodeLayoutType.UINT8_AND_INT8_VALUE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + code.readUInt8(pc + 1) + " " + code.readInt8(pc + 2);
OpcodeLayoutPrinters[enums.OpcodeLayoutType.INT8_VALUE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + code.readInt8(pc + 1);
OpcodeLayoutPrinters[enums.OpcodeLayoutType.INT16_VALUE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + code.readInt16BE(pc + 1);
OpcodeLayoutPrinters[enums.OpcodeLayoutType.INT32_VALUE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + code.readInt32BE(pc + 1);
OpcodeLayoutPrinters[enums.OpcodeLayoutType.ARRAY_TYPE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase() + " " + opcodes.ArrayTypes[code.readUInt8(pc + 1)];
OpcodeLayoutPrinters[enums.OpcodeLayoutType.WIDE] = (frame: BytecodeStackFrame, code: NodeBuffer, pc: number) => enums.OpCode[code.readUInt8(pc)].toLowerCase();

function annotateOpcode(op: number, frame: BytecodeStackFrame, code: NodeBuffer, pc: number): string {
  return OpcodeLayoutPrinters[enums.OpcodeLayouts[op]](frame, code, pc);
}

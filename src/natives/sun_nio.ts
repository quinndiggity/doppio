import threading = require('../threading');
import logging = require('../logging');
import ClassData = require('../ClassData');
import gLong = require('../gLong');
import util = require('../util');
import enums = require('../enums');
import fs = require('fs');
import JVMTypes = require('../../includes/JVMTypes');
declare var registerNatives: (defs: any) => void;

class sun_nio_ch_FileChannelImpl {

  public static 'map0(IJJ)J'(thread: threading.JVMThread, javaThis: JVMTypes.sun_nio_ch_FileChannelImpl, arg0: number, arg1: gLong, arg2: gLong): gLong {
    thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', 'Native method not implemented.');
    // Satisfy TypeScript return type.
    return null;
  }

  public static 'unmap0(JJ)I'(thread: threading.JVMThread, arg0: gLong, arg1: gLong): number {
    thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', 'Native method not implemented.');
    // Satisfy TypeScript return type.
    return 0;
  }

  public static 'transferTo0(IJJI)J'(thread: threading.JVMThread, javaThis: JVMTypes.sun_nio_ch_FileChannelImpl, arg0: number, arg1: gLong, arg2: gLong, arg3: number): gLong {
    thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', 'Native method not implemented.');
    // Satisfy TypeScript return type.
    return null;
  }

  public static 'position0(Ljava/io/FileDescriptor;J)J'(thread: threading.JVMThread, javaThis: JVMTypes.sun_nio_ch_FileChannelImpl, fd: JVMTypes.java_io_FileDescriptor, offset: gLong): gLong {
    return gLong.fromNumber(offset.equals(gLong.NEG_ONE) ? fd.$pos : fd.$pos = offset.toNumber());
  }

  /**
   * this poorly-named method actually specifies the page size for mmap
   * This is the Mac name for sun/misc/Unsafe::pageSize. Apparently they
   * wanted to ensure page sizes can be > 2GB...
   */
  public static 'initIDs()J'(thread: threading.JVMThread): gLong {
    // arbitrary
    return gLong.fromNumber(1024);
  }

}

class sun_nio_ch_NativeThread {

  public static 'current()J'(thread: threading.JVMThread): gLong {
    // -1 means that we do not require signaling according to the
    // docs.
    return gLong.fromNumber(-1);
  }

  public static 'signal(J)V'(thread: threading.JVMThread, arg0: gLong): void {
    thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', 'Native method not implemented.');
  }

  public static 'init()V'(thread: threading.JVMThread): void {
    // NOP
  }

}

class sun_nio_ch_IOUtil {

  public static 'iovMax()I'(thread: threading.JVMThread): number {
    // Maximum number of IOVectors supported. Let's punt and say zero.
    return 0;
  }

}

class sun_nio_ch_FileDispatcherImpl {

  public static 'init()V'(thread: threading.JVMThread): void {

  }

  public static 'read0(Ljava/io/FileDescriptor;JI)I'(thread: threading.JVMThread, fdObj: JVMTypes.java_io_FileDescriptor, address: gLong, len: number): void {
    var fd = fdObj["java/io/FileDescriptor/fd"],
      // read upto len bytes and store into mmap'd buffer at address
      addr = address.toNumber(),
      buf = new Buffer(len);
    thread.setStatus(enums.ThreadStatus.ASYNC_WAITING);
    fs.read(fd, buf, 0, len, 0, (err, bytesRead) => {
      if (err) {
        thread.throwNewException("Ljava/io/IOException;", 'Error reading file: ' + err);
      } else {
        var i: number, heap = thread.getThreadPool().getJVM().getHeap();
        for (i = 0; i < bytesRead; i++) {
          heap.set_byte(addr + i, buf.readUInt8(i));
        }
        thread.asyncReturn(bytesRead);
      }
    });
  }

  public static 'preClose0(Ljava/io/FileDescriptor;)V'(thread: threading.JVMThread, arg0: JVMTypes.java_io_FileDescriptor): void {
    // NOP, I think the actual fs.close is called later. If not, NBD.
  }

}

registerNatives({
  'sun/nio/ch/FileChannelImpl': sun_nio_ch_FileChannelImpl,
  'sun/nio/ch/NativeThread': sun_nio_ch_NativeThread,
  'sun/nio/ch/IOUtil': sun_nio_ch_IOUtil,
  'sun/nio/ch/FileDispatcherImpl': sun_nio_ch_FileDispatcherImpl
});

//@ sourceURL=natives/sun_nio.js
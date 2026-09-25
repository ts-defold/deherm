var LibraryDefoldWebTransport = {
  $DefoldWebTransport: {
    sessions: new Map(),
    streams: new Map(),
    events: [],
    eventBytes: 0,
    maximumSessions: 16,
    maximumEvents: 64,
    maximumEventBytes: 256 * 1024,
    maximumTerminalBytes: 16 * 1024,
    maximumWriteBytes: 64 * 1024,
    maximumPendingStreams: 16,
    // Match the native core's bounded registry and preserve the WebTransport
    // baseline of at least 100 incoming streams in each direction.
    maximumStreamsPerSession: 256,
    maximumDatagramsInFlight: 16,
    maximumDatagramBytesInFlight: 64 * 1024,
    readHighWaterEvents: 48,
    readLowWaterEvents: 32,
    readHighWaterBytes: 192 * 1024,
    readLowWaterBytes: 128 * 1024,
    allocateHandle: function () {
      var handle = _malloc(4);
      if (handle) HEAPU32[handle >>> 2] = 0x5754;
      return handle;
    },
    releaseHandle: function (handle) {
      if (handle) _free(handle);
    },
    releaseStream: function (stream) {
      if (!stream || stream.released) return;
      stream.released = true;
      DefoldWebTransport.streams.delete(stream.handle);
      if (stream.session.streams.delete(stream.handle) && stream.session.liveStreams > 0) {
        --stream.session.liveStreams;
      }
      DefoldWebTransport.releaseHandle(stream.handle);
      stream.handle = 0;
    },
    removeQueuedEvents: function (session) {
      var retained = [];
      var retainedBytes = 0;
      for (var event of DefoldWebTransport.events) {
        if (event.session !== session) {
          retained.push(event);
          retainedBytes += event.bytes ? event.bytes.byteLength : 0;
        }
      }
      DefoldWebTransport.events = retained;
      DefoldWebTransport.eventBytes = retainedBytes;
      session.nativeEvents = [];
      session.nativeEventBytes = 0;
    },
    normalizeCloseReason: function (reason) {
      var result = "";
      var bytes = 0;
      for (var codePoint of String(reason || "")) {
        var width = new TextEncoder().encode(codePoint).byteLength;
        if (bytes + width > 1024) break;
        result += codePoint;
        bytes += width;
      }
      return result;
    },
    streamErrorCode: function (error) {
      if (typeof WebTransportError === "function" && error instanceof WebTransportError &&
          Number.isInteger(error.streamErrorCode) && error.streamErrorCode >= 0) {
        return error.streamErrorCode >>> 0;
      }
      return 0;
    },
    streamWriteFailed: function (stream, error) {
      if (!stream || stream.released || stream.writeTerminal || stream.session.closeRequested) return;
      stream.writeTerminal = true;
      DefoldWebTransport.enqueue(stream.session, {type: 6, stream: stream,
        code: DefoldWebTransport.streamErrorCode(error), reason: String(error)});
    },
    waitForReadCapacity: function (session) {
      var eventCount = session.callback ? DefoldWebTransport.events.length : session.nativeEvents.length;
      var eventBytes = session.callback ? DefoldWebTransport.eventBytes : session.nativeEventBytes;
      if (eventCount < DefoldWebTransport.readHighWaterEvents &&
          eventBytes < DefoldWebTransport.readHighWaterBytes) return Promise.resolve();
      return new Promise(function (resolve) { session.readCapacityWaiters.push(resolve); });
    },
    resumeReaders: function (session) {
      if (!session || !session.readCapacityWaiters) return;
      var eventCount = session.callback ? DefoldWebTransport.events.length : session.nativeEvents.length;
      var eventBytes = session.callback ? DefoldWebTransport.eventBytes : session.nativeEventBytes;
      if (eventCount > DefoldWebTransport.readLowWaterEvents ||
          eventBytes > DefoldWebTransport.readLowWaterBytes) return;
      for (var resume of session.readCapacityWaiters.splice(0)) resume();
    },
    wakeReaders: function (session) {
      if (!session || !session.readCapacityWaiters) return;
      for (var resume of session.readCapacityWaiters.splice(0)) resume();
    },
    queueClose: function (session, code, reason) {
      if (!session || session.destroyed || session.closeEmitted) return;
      session.closeEmitted = true;
      var text = DefoldWebTransport.normalizeCloseReason(reason);
      var event = {session: session, type: 7, code: code >>> 0, reason: text,
        bytes: new TextEncoder().encode(text)};
      if (session.callback) {
        DefoldWebTransport.events.push(event);
        DefoldWebTransport.eventBytes += event.bytes.byteLength;
      } else {
        session.nativeEvents.push(event);
        session.nativeEventBytes += event.bytes.byteLength;
      }
    },
    failSession: function (session, reason) {
      if (!session || session.destroyed || session.closeEmitted) return;
      var text = DefoldWebTransport.normalizeCloseReason(reason);
      session.overflowed = true;
      session.ready = false;
      session.state = 5;
      DefoldWebTransport.wakeReaders(session);
      DefoldWebTransport.removeQueuedEvents(session);
      if (!session.closeRequested && session.transport) {
        session.closeRequested = true;
        try { session.transport.close({closeCode: 2, reason: text}); } catch (_) {}
      }
      DefoldWebTransport.queueClose(session, 2, text);
    },
    enqueue: function (session, event) {
      if (!session || session.destroyed || session.closeEmitted) return;
      if (session.closeRequested && event.type !== 7) return;
      var size = event.bytes ? event.bytes.byteLength : 0;
      if (!session.callback) {
        if (session.nativeEvents.length >= DefoldWebTransport.maximumEvents - 1 ||
            size > DefoldWebTransport.maximumEventBytes - DefoldWebTransport.maximumTerminalBytes -
                session.nativeEventBytes) {
          DefoldWebTransport.failSession(session, "browser WebTransport event queue is full");
          return;
        }
        event.session = session;
        event.bytes = event.bytes || new Uint8Array(0);
        session.nativeEvents.push(event);
        session.nativeEventBytes += size;
        return;
      }
      if (DefoldWebTransport.events.length >=
              DefoldWebTransport.maximumEvents - DefoldWebTransport.maximumSessions ||
          size > DefoldWebTransport.maximumEventBytes - DefoldWebTransport.maximumTerminalBytes -
              DefoldWebTransport.eventBytes) {
        DefoldWebTransport.failSession(session, "browser WebTransport event queue is full");
        return;
      }
      event.session = session;
      event.bytes = event.bytes || new Uint8Array(0);
      DefoldWebTransport.events.push(event);
      DefoldWebTransport.eventBytes += size;
    },
    stream: function (session, nativeStream, bidirectional, incoming) {
      if (!session || session.destroyed || session.closeRequested ||
          session.liveStreams >= DefoldWebTransport.maximumStreamsPerSession) return null;
      var handle = DefoldWebTransport.allocateHandle();
      if (!handle) return null;
      var stream = {handle: handle, session: session, native: nativeStream,
        bidirectional: bidirectional, incoming: incoming, writer: null, buffered: 0,
        released: false, readTerminal: !nativeStream.readable, writeTerminal: !nativeStream.writable};
      DefoldWebTransport.streams.set(handle, stream);
      session.streams.add(handle);
      ++session.liveStreams;
      if (nativeStream.writable) stream.writer = nativeStream.writable.getWriter();
      if (nativeStream.readable) DefoldWebTransport.readStream(stream);
      return stream;
    },
    readStream: async function (stream) {
      var reader = stream.native.readable.getReader();
      stream.session.readers.add(reader);
      try {
        while (!stream.session.destroyed && !stream.session.closeRequested) {
          await DefoldWebTransport.waitForReadCapacity(stream.session);
          if (stream.session.destroyed || stream.session.closeRequested) break;
          var result = await reader.read();
          if (stream.released || stream.session.closeRequested) break;
          if (result.done) {
            stream.readTerminal = true;
            DefoldWebTransport.enqueue(stream.session, {type: 3, stream: stream,
              bytes: new Uint8Array(0), fin: true});
            break;
          }
          if (result.value.byteLength > DefoldWebTransport.maximumEventBytes) {
            DefoldWebTransport.failSession(stream.session, "browser WebTransport stream chunk is too large");
            break;
          }
          var bytes = new Uint8Array(result.value.buffer, result.value.byteOffset, result.value.byteLength).slice();
          DefoldWebTransport.enqueue(stream.session, {type: 3, stream: stream, bytes: bytes, fin: false});
        }
      } catch (error) {
        if (!stream.released && !stream.session.closeRequested) {
          stream.readTerminal = true;
          DefoldWebTransport.enqueue(stream.session, {type: 5, stream: stream,
            code: DefoldWebTransport.streamErrorCode(error),
            reason: String(error)});
        }
      } finally {
        stream.session.readers.delete(reader);
        reader.releaseLock();
      }
    },
    readIncoming: async function (session, readable, bidirectional) {
      var reader = readable.getReader();
      session.readers.add(reader);
      try {
        while (!session.destroyed && !session.closeRequested) {
          await DefoldWebTransport.waitForReadCapacity(session);
          if (session.destroyed || session.closeRequested) break;
          var result = await reader.read();
          if (result.done) break;
          var nativeStream = bidirectional ? result.value : {readable: result.value};
          if (session.destroyed || session.closeRequested) {
            try { if (nativeStream.writable) await nativeStream.writable.abort(); } catch (_) {}
            try { if (nativeStream.readable) await nativeStream.readable.cancel(); } catch (_) {}
            break;
          }
          var stream = DefoldWebTransport.stream(session, nativeStream, bidirectional, true);
          if (!stream) {
            try { if (nativeStream.writable) await nativeStream.writable.abort(); } catch (_) {}
            try { if (nativeStream.readable) await nativeStream.readable.cancel(); } catch (_) {}
            DefoldWebTransport.failSession(session, "browser stream registry allocation failed");
            break;
          }
          DefoldWebTransport.enqueue(session, {type: 2, stream: stream,
            bidirectional: bidirectional, incoming: true});
        }
      } catch (error) {
        if (!session.destroyed && !session.closeRequested) DefoldWebTransport.failSession(session, String(error));
      } finally {
        session.readers.delete(reader);
        reader.releaseLock();
      }
    },
    readDatagrams: async function (session) {
      var reader = session.transport.datagrams.readable.getReader();
      session.readers.add(reader);
      try {
        while (!session.destroyed && !session.closeRequested) {
          await DefoldWebTransport.waitForReadCapacity(session);
          if (session.destroyed || session.closeRequested) break;
          var result = await reader.read();
          if (result.done) break;
          if (session.closeRequested) break;
          if (result.value.byteLength > DefoldWebTransport.maximumEventBytes) {
            DefoldWebTransport.failSession(session, "browser WebTransport datagram is too large");
            break;
          }
          var bytes = new Uint8Array(result.value.buffer, result.value.byteOffset, result.value.byteLength).slice();
          DefoldWebTransport.enqueue(session, {type: 4, bytes: bytes});
        }
      } catch (error) {
        if (!session.destroyed && !session.closeRequested) DefoldWebTransport.failSession(session, String(error));
      } finally {
        session.readers.delete(reader);
        reader.releaseLock();
      }
    },
    closeSession: function (session) {
      if (!session || session.destroyed) return;
      session.destroyed = true;
      DefoldWebTransport.sessions.delete(session.handle);
      for (var reader of session.readers) {
        try { reader.cancel().catch(function () {}); } catch (_) {}
      }
      session.readers.clear();
      DefoldWebTransport.wakeReaders(session);
      if (session.datagramWriter) {
        try { session.datagramWriter.abort().catch(function () {}); } catch (_) {}
      }
      for (var handle of session.streams) {
        var stream = DefoldWebTransport.streams.get(handle);
        if (stream && stream.writer) {
          try { stream.writer.abort().catch(function () {}); } catch (_) {}
        }
        DefoldWebTransport.releaseStream(stream);
      }
      session.streams.clear();
      DefoldWebTransport.releaseHandle(session.handle);
    }
  },

  defold_webtransport_connect__deps: ["$DefoldWebTransport"],
  defold_webtransport_connect: function (options) {
    if (!options || HEAPU32[options >>> 2] !== 1 || HEAPU32[(options + 4) >>> 2] < 32) return 0;
    if (DefoldWebTransport.sessions.size >= DefoldWebTransport.maximumSessions) return 0;
    var urlPointer = HEAPU32[(options + 8) >>> 2];
    var callback = HEAPU32[(options + 24) >>> 2];
    if (!urlPointer || !callback || typeof WebTransport !== "function") return 0;
    var hashes = [];
    var hashesPointer = HEAPU32[(options + 12) >>> 2];
    var hashCount = HEAPU32[(options + 16) >>> 2];
    if (hashCount > 8) return 0;
    if (hashCount && !hashesPointer) return 0;
    for (var i = 0; i < hashCount; ++i) {
      var entry = hashesPointer + i * 12;
      var algorithmPointer = HEAPU32[entry >>> 2];
      var dataPointer = HEAPU32[(entry + 4) >>> 2];
      var dataSize = HEAPU32[(entry + 8) >>> 2];
      if (algorithmPointer && dataPointer && dataSize === 32) {
        var algorithm = UTF8ToString(algorithmPointer);
        if (algorithm.toLowerCase() === "sha-256") {
          hashes.push({algorithm: algorithm, value: HEAPU8.slice(dataPointer, dataPointer + dataSize)});
        }
      }
    }
    var handle = DefoldWebTransport.allocateHandle();
    if (!handle) return 0;
    var session = {handle: handle, callback: callback, userData: HEAPU32[(options + 28) >>> 2],
      transport: null, streams: new Set(), liveStreams: 0, datagramWriter: null, ready: false,
      buffered: 0, pendingStreams: 0, datagramsInFlight: 0, datagramBytesInFlight: 0,
      readers: new Set(), nativeEvents: [], nativeEventBytes: 0, state: 1,
      readCapacityWaiters: [],
      destroyed: false, overflowed: false, closeRequested: false, closeEmitted: false};
    try {
      var browserOptions = {
        anticipatedConcurrentIncomingUnidirectionalStreams: HEAPU16[(options + 20) >>> 1],
        anticipatedConcurrentIncomingBidirectionalStreams: HEAPU16[(options + 22) >>> 1]
      };
      if (hashes.length) browserOptions.serverCertificateHashes = hashes;
      session.transport = new WebTransport(UTF8ToString(urlPointer), browserOptions);
    } catch (error) {
      DefoldWebTransport.releaseHandle(handle);
      return 0;
    }
    DefoldWebTransport.sessions.set(handle, session);
    session.transport.ready.then(function () {
      if (session.destroyed || session.closeRequested) return;
      session.ready = true;
      session.state = 2;
      session.datagramWriter = session.transport.datagrams.writable.getWriter();
      DefoldWebTransport.enqueue(session, {type: 1});
      DefoldWebTransport.readDatagrams(session);
      DefoldWebTransport.readIncoming(session, session.transport.incomingBidirectionalStreams, true);
      DefoldWebTransport.readIncoming(session, session.transport.incomingUnidirectionalStreams, false);
    }).catch(function (error) {
      DefoldWebTransport.failSession(session, String(error));
    });
    session.transport.closed.then(function (info) {
      session.state = 4;
      DefoldWebTransport.queueClose(session, info && info.closeCode || 0,
        info && info.reason || "");
    }).catch(function (error) {
      session.state = 5;
      DefoldWebTransport.failSession(session, String(error));
    });
    return handle;
  },

  defold_webtransport_close__deps: ["$DefoldWebTransport"],
  defold_webtransport_close: function (handle, code, reasonPointer) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (session && !session.destroyed && !session.closeRequested) {
      session.closeRequested = true;
      session.state = 3;
      DefoldWebTransport.wakeReaders(session);
      try {
        session.transport.close({closeCode: code >>> 0,
          reason: DefoldWebTransport.normalizeCloseReason(reasonPointer ? UTF8ToString(reasonPointer) : "")});
      } catch (error) {
        DefoldWebTransport.failSession(session, String(error));
      }
    }
  },

  defold_webtransport_destroy__deps: ["$DefoldWebTransport"],
  defold_webtransport_destroy: function (handle) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session) return;
    if (!session.destroyed && session.transport && !session.closeRequested) {
      session.closeRequested = true;
      try { session.transport.close({closeCode: 0, reason: ""}); } catch (_) {}
    }
    DefoldWebTransport.closeSession(session);
  },

  defold_webtransport_create_bidirectional_stream__deps: ["$DefoldWebTransport"],
  defold_webtransport_create_bidirectional_stream: function (handle) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session || !session.ready || session.destroyed || session.closeRequested ||
        session.pendingStreams >= DefoldWebTransport.maximumPendingStreams ||
        session.liveStreams + session.pendingStreams >= DefoldWebTransport.maximumStreamsPerSession) return 0;
    ++session.pendingStreams;
    session.transport.createBidirectionalStream().then(function (nativeStream) {
      --session.pendingStreams;
      if (session.destroyed || session.closeRequested) {
        try { nativeStream.writable.abort().catch(function () {}); } catch (_) {}
        try { nativeStream.readable.cancel().catch(function () {}); } catch (_) {}
        return;
      }
      var stream = DefoldWebTransport.stream(session, nativeStream, true, false);
      if (stream) DefoldWebTransport.enqueue(session, {type: 2, stream: stream,
        bidirectional: true, incoming: false});
      else DefoldWebTransport.failSession(session, "browser stream registry allocation failed");
    }).catch(function (error) {
      --session.pendingStreams;
      if (!session.destroyed && !session.closeRequested) DefoldWebTransport.failSession(session, String(error));
    });
    return 1;
  },

  defold_webtransport_create_unidirectional_stream__deps: ["$DefoldWebTransport"],
  defold_webtransport_create_unidirectional_stream: function (handle) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session || !session.ready || session.destroyed || session.closeRequested ||
        session.pendingStreams >= DefoldWebTransport.maximumPendingStreams ||
        session.liveStreams + session.pendingStreams >= DefoldWebTransport.maximumStreamsPerSession) return 0;
    ++session.pendingStreams;
    session.transport.createUnidirectionalStream().then(function (writable) {
      --session.pendingStreams;
      if (session.destroyed || session.closeRequested) {
        try { writable.abort().catch(function () {}); } catch (_) {}
        return;
      }
      var stream = DefoldWebTransport.stream(session, {writable: writable}, false, false);
      if (stream) DefoldWebTransport.enqueue(session, {type: 2, stream: stream,
        bidirectional: false, incoming: false});
      else DefoldWebTransport.failSession(session, "browser stream registry allocation failed");
    }).catch(function (error) {
      --session.pendingStreams;
      if (!session.destroyed && !session.closeRequested) DefoldWebTransport.failSession(session, String(error));
    });
    return 1;
  },

  defold_webtransport_stream_write__deps: ["$DefoldWebTransport"],
  defold_webtransport_stream_write: function (handle, bytesPointer, fin) {
    var stream = DefoldWebTransport.streams.get(handle);
    var size = HEAPU32[(bytesPointer + 4) >>> 2];
    var data = HEAPU32[bytesPointer >>> 2];
    if (!stream || !stream.writer || stream.writeTerminal || stream.session.destroyed ||
        stream.session.closeRequested ||
        size > DefoldWebTransport.maximumWriteBytes ||
        size > DefoldWebTransport.maximumEventBytes - stream.session.buffered || (size && !data)) return 0;
    var copy = HEAPU8.slice(data, data + size);
    stream.session.buffered += size;
    stream.writer.write(copy).then(function () {
      if (fin) {
        return stream.writer.close().then(function () { stream.writeTerminal = true; });
      }
    }).catch(function (error) {
      DefoldWebTransport.streamWriteFailed(stream, error);
    }).finally(function () {
      stream.session.buffered -= size;
    });
    return 1;
  },

  defold_webtransport_stream_reset__deps: ["$DefoldWebTransport"],
  defold_webtransport_stream_reset: function (handle, code) {
    var stream = DefoldWebTransport.streams.get(handle);
    if (stream && stream.writer && !stream.writeTerminal) {
      stream.writeTerminal = true;
      stream.writer.abort({streamErrorCode: code >>> 0}).catch(function () {});
      return 1;
    }
    return 0;
  },

  defold_webtransport_stream_stop_sending__deps: ["$DefoldWebTransport"],
  defold_webtransport_stream_stop_sending: function (handle, code) {
    var stream = DefoldWebTransport.streams.get(handle);
    if (stream && stream.native.readable && !stream.readTerminal) {
      stream.readTerminal = true;
      stream.native.readable.cancel({streamErrorCode: code >>> 0}).catch(function () {});
      return 1;
    }
    return 0;
  },

  defold_webtransport_stream_release__deps: ["$DefoldWebTransport"],
  defold_webtransport_stream_release: function (handle) {
    DefoldWebTransport.releaseStream(DefoldWebTransport.streams.get(handle));
  },

  defold_webtransport_send_datagram__deps: ["$DefoldWebTransport"],
  defold_webtransport_send_datagram: function (handle, bytesPointer) {
    var session = DefoldWebTransport.sessions.get(handle);
    var size = HEAPU32[(bytesPointer + 4) >>> 2];
    var data = HEAPU32[bytesPointer >>> 2];
    var maximum = session && session.transport.datagrams.maxDatagramSize || 0;
    if (!session || !session.datagramWriter || session.destroyed || session.closeRequested ||
        size > maximum || (size && !data) ||
        session.datagramsInFlight >= DefoldWebTransport.maximumDatagramsInFlight ||
        size > DefoldWebTransport.maximumDatagramBytesInFlight - session.datagramBytesInFlight ||
        (session.datagramWriter.desiredSize !== null && session.datagramWriter.desiredSize <= 0)) return 0;
    ++session.datagramsInFlight;
    session.datagramBytesInFlight += size;
    session.datagramWriter.write(HEAPU8.slice(data, data + size)).catch(function (error) {
      if (!session.closeRequested) DefoldWebTransport.failSession(session, String(error));
    }).finally(function () {
      --session.datagramsInFlight;
      session.datagramBytesInFlight -= size;
    });
    return 1;
  },

  defold_webtransport_max_datagram_size__deps: ["$DefoldWebTransport"],
  defold_webtransport_max_datagram_size: function (handle) {
    var session = DefoldWebTransport.sessions.get(handle);
    return session && session.ready ? session.transport.datagrams.maxDatagramSize >>> 0 : 0;
  },

  defold_webtransport_native_v1_open__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_open: function (urlPointer, urlLength, digestPointer, digestLength,
      anticipatedIncomingUnidirectionalStreams, anticipatedIncomingBidirectionalStreams) {
    if (!urlPointer || !urlLength || !digestPointer || digestLength !== 32 || typeof WebTransport !== "function") return 0;
    if (DefoldWebTransport.sessions.size >= DefoldWebTransport.maximumSessions) return 0;
    var handle = DefoldWebTransport.allocateHandle();
    if (!handle) return 0;
    var session = {handle: handle, callback: 0, userData: 0, transport: null, streams: new Set(), liveStreams: 0,
      datagramWriter: null, ready: false, buffered: 0, pendingStreams: 0, datagramsInFlight: 0,
      datagramBytesInFlight: 0, readers: new Set(), nativeEvents: [], nativeEventBytes: 0,
      readCapacityWaiters: [],
      state: 1, destroyed: false, overflowed: false, closeRequested: false, closeEmitted: false};
    try {
      session.transport = new WebTransport(UTF8ToString(urlPointer, urlLength), {
        serverCertificateHashes: [{algorithm: "sha-256", value: HEAPU8.slice(digestPointer, digestPointer + 32)}],
        anticipatedConcurrentIncomingUnidirectionalStreams: anticipatedIncomingUnidirectionalStreams >>> 0,
        anticipatedConcurrentIncomingBidirectionalStreams: anticipatedIncomingBidirectionalStreams >>> 0
      });
    } catch (_) {
      DefoldWebTransport.releaseHandle(handle);
      return 0;
    }
    DefoldWebTransport.sessions.set(handle, session);
    session.transport.ready.then(function () {
      if (session.destroyed || session.closeRequested) return;
      session.ready = true; session.state = 2;
      session.datagramWriter = session.transport.datagrams.writable.getWriter();
      DefoldWebTransport.enqueue(session, {type: 1});
      DefoldWebTransport.readDatagrams(session);
      DefoldWebTransport.readIncoming(session, session.transport.incomingBidirectionalStreams, true);
      DefoldWebTransport.readIncoming(session, session.transport.incomingUnidirectionalStreams, false);
    }).catch(function (error) {
      DefoldWebTransport.failSession(session, String(error));
    });
    session.transport.closed.then(function (info) {
      session.state = 4;
      var reason = info && info.reason || "";
      DefoldWebTransport.queueClose(session, info && info.closeCode || 0, reason);
    }).catch(function (error) {
      DefoldWebTransport.failSession(session, String(error));
    });
    return handle;
  },

  defold_webtransport_native_v1_state__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_state: function (handle) {
    var session = DefoldWebTransport.sessions.get(handle);
    return session ? session.state : 5;
  },

  defold_webtransport_native_v1_max_datagram_bytes__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_max_datagram_bytes: function (handle) {
    var session = DefoldWebTransport.sessions.get(handle);
    return session && session.ready ? session.transport.datagrams.maxDatagramSize >>> 0 : 0;
  },

  defold_webtransport_native_v1_open_bidirectional_stream__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_open_bidirectional_stream: function (handle, requestId) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session || !requestId) return -1;
    if (!session.ready || session.destroyed || session.closeRequested) return -5;
    if (session.pendingStreams >= DefoldWebTransport.maximumPendingStreams ||
        session.liveStreams + session.pendingStreams >= DefoldWebTransport.maximumStreamsPerSession) return 1;
    ++session.pendingStreams;
    session.transport.createBidirectionalStream().then(function (nativeStream) {
      --session.pendingStreams;
      if (session.destroyed || session.closeRequested) {
        try { nativeStream.writable.abort().catch(function () {}); } catch (_) {}
        try { nativeStream.readable.cancel().catch(function () {}); } catch (_) {}
        return;
      }
      var stream = DefoldWebTransport.stream(session, nativeStream, true, false);
      if (stream) DefoldWebTransport.enqueue(session, {type: 2, stream: stream, requestId: requestId,
        bidirectional: true, incoming: false});
      else DefoldWebTransport.failSession(session, "browser stream registry allocation failed");
    }).catch(function (error) {
      --session.pendingStreams;
      if (!session.destroyed && !session.closeRequested) DefoldWebTransport.failSession(session, String(error));
    });
    return 0;
  },

  defold_webtransport_native_v1_open_unidirectional_stream__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_open_unidirectional_stream: function (handle, requestId) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session || !requestId) return -1;
    if (!session.ready || session.destroyed || session.closeRequested) return -5;
    if (session.pendingStreams >= DefoldWebTransport.maximumPendingStreams ||
        session.liveStreams + session.pendingStreams >= DefoldWebTransport.maximumStreamsPerSession) return 1;
    ++session.pendingStreams;
    session.transport.createUnidirectionalStream().then(function (writable) {
      --session.pendingStreams;
      if (session.destroyed || session.closeRequested) {
        try { writable.abort().catch(function () {}); } catch (_) {}
        return;
      }
      var stream = DefoldWebTransport.stream(session, {writable: writable}, false, false);
      if (stream) DefoldWebTransport.enqueue(session, {type: 2, stream: stream, requestId: requestId,
        bidirectional: false, incoming: false});
      else DefoldWebTransport.failSession(session, "browser stream registry allocation failed");
    }).catch(function (error) {
      --session.pendingStreams;
      if (!session.destroyed && !session.closeRequested) DefoldWebTransport.failSession(session, String(error));
    });
    return 0;
  },

  defold_webtransport_native_v1_write_stream__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_write_stream: function (handle, streamHandle, data, size, fin) {
    var session = DefoldWebTransport.sessions.get(handle);
    var stream = DefoldWebTransport.streams.get(streamHandle);
    if (!session || !stream || stream.session !== session || (size && !data)) return -1;
    if (!stream.writer || stream.writeTerminal || session.destroyed || session.closeRequested) return -5;
    if (size > DefoldWebTransport.maximumWriteBytes) return -3;
    if (size > DefoldWebTransport.maximumEventBytes - session.buffered) return 1;
    session.buffered += size;
    stream.writer.write(HEAPU8.slice(data, data + size)).then(function () {
      if (fin) {
        return stream.writer.close().then(function () { stream.writeTerminal = true; });
      }
    }).catch(function (error) {
      DefoldWebTransport.streamWriteFailed(stream, error);
    }).finally(function () {
      session.buffered -= size;
    });
    return 0;
  },

  defold_webtransport_native_v1_reset_stream__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_reset_stream: function (handle, streamHandle, code) {
    var stream = DefoldWebTransport.streams.get(streamHandle);
    if (!stream || stream.session.handle !== handle) return -1;
    if (!stream.writer || stream.writeTerminal) return -2;
    stream.writeTerminal = true;
    stream.writer.abort({streamErrorCode: code >>> 0}).catch(function () {}); return 0;
  },

  defold_webtransport_native_v1_stop_sending__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_stop_sending: function (handle, streamHandle, code) {
    var stream = DefoldWebTransport.streams.get(streamHandle);
    if (!stream || stream.session.handle !== handle) return -1;
    if (!stream.native.readable || stream.readTerminal) return -2;
    stream.readTerminal = true;
    stream.native.readable.cancel({streamErrorCode: code >>> 0}).catch(function () {}); return 0;
  },

  defold_webtransport_native_v1_try_send_datagram__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_try_send_datagram: function (handle, data, size) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session || (size && !data)) return -1;
    if (!session.datagramWriter || session.destroyed || session.closeRequested) return -5;
    if (size > session.transport.datagrams.maxDatagramSize) return -3;
    if (session.datagramsInFlight >= DefoldWebTransport.maximumDatagramsInFlight ||
        size > DefoldWebTransport.maximumDatagramBytesInFlight - session.datagramBytesInFlight ||
        (session.datagramWriter.desiredSize !== null && session.datagramWriter.desiredSize <= 0)) return 1;
    ++session.datagramsInFlight; session.datagramBytesInFlight += size;
    session.datagramWriter.write(HEAPU8.slice(data, data + size)).catch(function (error) {
      if (!session.closeRequested) DefoldWebTransport.failSession(session, String(error));
    }).finally(function () { --session.datagramsInFlight; session.datagramBytesInFlight -= size; });
    return 0;
  },

  defold_webtransport_native_v1_poll__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_poll: function (handle, output, outputLength) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session || !output || outputLength < 32) return -1;
    var event = session.nativeEvents[0];
    if (!event) return 2;
    var bytes = event.bytes || new Uint8Array(0);
    var flags = (event.fin ? 1 : 0) | (event.bidirectional ? 2 : 0) | (event.incoming ? 4 : 0);
    HEAPU32[output >>> 2] = event.type >>> 0;
    HEAPU32[(output + 4) >>> 2] = flags;
    HEAP32[(output + 8) >>> 2] = event.code | 0;
    HEAPU32[(output + 12) >>> 2] = event.requestId >>> 0;
    HEAPU32[(output + 16) >>> 2] = event.stream ? event.stream.handle : 0;
    HEAPU32[(output + 20) >>> 2] = bytes.byteLength;
    HEAPU32[(output + 24) >>> 2] = 0;
    HEAPU32[(output + 28) >>> 2] = 1;
    if (bytes.byteLength > outputLength - 32) return -4;
    if (bytes.byteLength) HEAPU8.set(bytes, output + 32);
    session.nativeEvents.shift(); session.nativeEventBytes -= bytes.byteLength;
    DefoldWebTransport.resumeReaders(session);
    return 0;
  },

  defold_webtransport_native_v1_close__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_close: function (handle, code, reason, reasonLength) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session || (reasonLength && !reason)) return -1;
    if (session.destroyed) return -5;
    if (session.closeRequested) return 0;
    session.state = 3;
    session.closeRequested = true;
    DefoldWebTransport.wakeReaders(session);
    try {
      session.transport.close({closeCode: code >>> 0,
        reason: DefoldWebTransport.normalizeCloseReason(reason ? UTF8ToString(reason, reasonLength) : "")});
    } catch (error) {
      DefoldWebTransport.failSession(session, String(error));
      return -2;
    }
    return 0;
  },

  defold_webtransport_native_v1_destroy__deps: ["$DefoldWebTransport"],
  defold_webtransport_native_v1_destroy: function (handle) {
    var session = DefoldWebTransport.sessions.get(handle);
    if (!session) return -1;
    if (!session.closeRequested) {
      session.closeRequested = true;
      try { session.transport.close({closeCode: 0, reason: ""}); } catch (_) {}
    }
    DefoldWebTransport.closeSession(session); return 0;
  },

  defold_webtransport_pump_callbacks__deps: ["$DefoldWebTransport"],
  defold_webtransport_pump_callbacks: function () {
    var delivered = 0;
    var events = DefoldWebTransport.events.splice(0);
    DefoldWebTransport.eventBytes = 0;
    var touchedSessions = new Set();
    for (var event of events) {
      var session = event.session;
      if (!session || session.destroyed) continue;
      touchedSessions.add(session);
      var save = stackSave();
      var bytesPointer = 0;
      var reasonPointer = 0;
      if (event.bytes && event.bytes.byteLength) {
        bytesPointer = stackAlloc(event.bytes.byteLength);
        HEAPU8.set(event.bytes, bytesPointer);
      }
      if (event.reason) {
        var reasonSize = lengthBytesUTF8(event.reason) + 1;
        reasonPointer = stackAlloc(reasonSize);
        stringToUTF8(event.reason, reasonPointer, reasonSize);
      }
      var target = stackAlloc(36);
      HEAPU8.fill(0, target, target + 36);
      HEAPU32[target >>> 2] = 36;
      HEAPU32[(target + 4) >>> 2] = event.type >>> 0;
      HEAPU32[(target + 8) >>> 2] = session.handle;
      HEAPU32[(target + 12) >>> 2] = event.stream ? event.stream.handle : 0;
      HEAPU32[(target + 16) >>> 2] = bytesPointer;
      HEAPU32[(target + 20) >>> 2] = event.bytes ? event.bytes.byteLength : 0;
      HEAPU32[(target + 24) >>> 2] = event.code >>> 0;
      HEAPU32[(target + 28) >>> 2] = reasonPointer;
      HEAPU8[target + 32] = event.fin ? 1 : 0;
      HEAPU8[target + 33] = event.bidirectional ? 1 : 0;
      HEAPU8[target + 34] = event.incoming ? 1 : 0;
      getWasmTableEntry(session.callback)(session.userData, target);
      stackRestore(save);
      ++delivered;
    }
    for (var touched of touchedSessions) DefoldWebTransport.resumeReaders(touched);
    for (var active of DefoldWebTransport.sessions.values()) DefoldWebTransport.resumeReaders(active);
    return delivered;
  }
};

autoAddDeps(LibraryDefoldWebTransport, "$DefoldWebTransport");
addToLibrary(LibraryDefoldWebTransport);

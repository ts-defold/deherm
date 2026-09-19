// The HTML5 socket layer for netcode: a WebTransport datagram channel.
//
// A browser cannot open a UDP socket, so on wasm the extension creates its
// netcode client with DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM and netcode never
// reaches a socket at all. What netcode wants sent lands in an outbound ring;
// what arrives has to be pushed into an inbound ring. This file is the piece
// that moves those two rings onto a real WebTransport session.
//
// EVIDENCE BOUNDARY, stated plainly because it is the difference between this
// file and everything else in this package: the C side of this seam is proven -
// packages/defold-netcode/tests/override_loopback.c drives the identical
// push/pop pair through a full handshake and payload exchange, natively and
// under emcc/node, with socket() poisoned. This FILE has not been run against a
// live WebTransport server. It is written, it is the shape the proven C seam
// requires, and it is unexecuted. Do not record it as runtime evidence.
//
// Why datagrams and not a reliable stream: netcode is an unreliable-ordered
// protocol with its own sequencing, replay protection and timeouts. Putting it
// on a reliable stream would reintroduce exactly the head-of-line blocking the
// protocol exists to avoid, and would make its loss handling dead code.
//
// Datagram size: netcode's largest packet is the connection request, which
// carries a 2048-byte connect token and so exceeds the ~1200-byte datagram most
// QUIC paths allow. A datagram that does not fit is DROPPED here rather than
// fragmented - netcode retransmits the connection request until the handshake
// completes, so a dropped one costs a retry, whereas a fragmentation scheme
// this file invented would be a second, unproven protocol under the first.
// `maxDatagramSize` is read from the session and reported, so a path too small
// for the handshake is visible rather than presenting as "connection timed out".

var LibraryDefoldNetcode = {
  $DEFOLD_NETCODE_WEB: {
    // One session per page. The extension holds one netcode client; a listen
    // server in the browser is not a thing, so there is no second channel.
    session: null,
    writer: null,
    reader: null,
    open: false,
    maxDatagramSize: 0,

    // Datagrams that arrived from the network and have not yet been handed to
    // netcode. Bounded: this is an unreliable channel, and an unbounded queue
    // in front of a protocol with its own replay window converts packet loss
    // into memory growth and latency.
    inbound: [],
    inboundCapacity: 256,

    // Counters rather than logs. A per-packet console.log in a 60Hz game is
    // itself a performance bug, and these are what a caller needs to tell "the
    // server is gone" from "we are dropping our own traffic".
    stats: {
      sent: 0,
      received: 0,
      droppedTooLarge: 0,
      droppedInboundFull: 0,
      writeErrors: 0
    },

    reset: function () {
      this.session = null;
      this.writer = null;
      this.reader = null;
      this.open = false;
      this.maxDatagramSize = 0;
      this.inbound.length = 0;
    },

    // Drains the session's datagram reader forever. Started once per session
    // and deliberately not awaited: netcode is polled from the game's update,
    // so this only has to keep `inbound` fed.
    pumpInbound: async function () {
      var reader = this.reader;
      try {
        while (this.open) {
          var result = await reader.read();
          if (result.done) break;
          if (this.inbound.length >= this.inboundCapacity) {
            // Drop the OLDEST, not the newest. A netcode client that falls
            // behind wants the most recent state, and the stale head is the
            // packet its replay window is most likely to reject anyway.
            this.inbound.shift();
            this.stats.droppedInboundFull++;
          }
          this.inbound.push(result.value);
          this.stats.received++;
        }
      } catch (error) {
        // A closed session surfaces here as a rejected read. That is a normal
        // end of life, not a fault, so it closes the channel rather than
        // throwing into an unhandled rejection.
        console.warn('[defold-netcode] datagram reader ended', error);
      }
      this.open = false;
    },

    connect: async function (url) {
      if (typeof WebTransport === 'undefined') {
        throw new Error('WebTransport is not available in this browser');
      }
      this.reset();
      var session = new WebTransport(url);
      await session.ready;

      this.session = session;
      this.writer = session.datagrams.writable.getWriter();
      this.reader = session.datagrams.readable.getReader();
      this.maxDatagramSize = session.datagrams.maxDatagramSize || 0;
      this.open = true;

      session.closed
        .then(function () {
          DEFOLD_NETCODE_WEB.open = false;
        })
        .catch(function () {
          DEFOLD_NETCODE_WEB.open = false;
        });

      this.pumpInbound();
      return this.maxDatagramSize;
    },

    close: function () {
      if (this.session) {
        try {
          this.session.close();
        } catch (error) {
          // Closing an already-closed session is not worth a diagnostic.
        }
      }
      this.reset();
    }
  },

  // Opens the session. Returns 1 on success, 0 on failure - the actual await
  // happens in JS and the wasm side polls `defoldNetcodeWebIsOpen`, because
  // blocking a Defold update on a promise is not an option.
  defoldNetcodeWebConnect__deps: ['$DEFOLD_NETCODE_WEB'],
  defoldNetcodeWebConnect: function (urlPointer) {
    var url = UTF8ToString(urlPointer);
    DEFOLD_NETCODE_WEB.connect(url).catch(function (error) {
      console.error('[defold-netcode] WebTransport connect failed', error);
      DEFOLD_NETCODE_WEB.open = false;
    });
    return 1;
  },

  defoldNetcodeWebIsOpen__deps: ['$DEFOLD_NETCODE_WEB'],
  defoldNetcodeWebIsOpen: function () {
    return DEFOLD_NETCODE_WEB.open ? 1 : 0;
  },

  defoldNetcodeWebMaxDatagramSize__deps: ['$DEFOLD_NETCODE_WEB'],
  defoldNetcodeWebMaxDatagramSize: function () {
    return DEFOLD_NETCODE_WEB.maxDatagramSize >>> 0;
  },

  defoldNetcodeWebClose__deps: ['$DEFOLD_NETCODE_WEB'],
  defoldNetcodeWebClose: function () {
    DEFOLD_NETCODE_WEB.close();
  },

  // Sends one datagram that `deherm_netcode_client_pop_datagram` produced.
  // Returns 1 if it was handed to the writer, 0 if it was dropped.
  defoldNetcodeWebSend__deps: ['$DEFOLD_NETCODE_WEB'],
  defoldNetcodeWebSend: function (dataPointer, byteCount) {
    var web = DEFOLD_NETCODE_WEB;
    if (!web.open || !web.writer) return 0;
    if (web.maxDatagramSize > 0 && byteCount > web.maxDatagramSize) {
      web.stats.droppedTooLarge++;
      return 0;
    }
    // The heap view is copied, not passed. The writer is asynchronous and the
    // wasm heap can be resized or overwritten before it runs; handing it a live
    // view would send whatever happened to be at that address later.
    var datagram = HEAPU8.slice(dataPointer, dataPointer + byteCount);
    web.writer.write(datagram).catch(function (error) {
      web.stats.writeErrors++;
      console.warn('[defold-netcode] datagram write failed', error);
    });
    web.stats.sent++;
    return 1;
  },

  // Copies the next inbound datagram into a wasm buffer for
  // `deherm_netcode_client_push_datagram`. Returns its length, 0 when the queue
  // is empty, or -1 when it will not fit the caller's buffer.
  defoldNetcodeWebReceive__deps: ['$DEFOLD_NETCODE_WEB'],
  defoldNetcodeWebReceive: function (bufferPointer, maxBytes) {
    var web = DEFOLD_NETCODE_WEB;
    if (!web.inbound.length) return 0;
    var datagram = web.inbound[0];
    if (datagram.byteLength > maxBytes) {
      web.inbound.shift();
      return -1;
    }
    web.inbound.shift();
    HEAPU8.set(datagram, bufferPointer);
    return datagram.byteLength;
  },

  // Six counters into a caller-provided int32 array, rather than six calls or a
  // JS object that would have to be marshalled. Diagnostics should not cost
  // more than the thing they diagnose.
  defoldNetcodeWebStats__deps: ['$DEFOLD_NETCODE_WEB'],
  defoldNetcodeWebStats: function (outPointer) {
    var stats = DEFOLD_NETCODE_WEB.stats;
    var out = outPointer >> 2;
    HEAP32[out + 0] = stats.sent;
    HEAP32[out + 1] = stats.received;
    HEAP32[out + 2] = stats.droppedTooLarge;
    HEAP32[out + 3] = stats.droppedInboundFull;
    HEAP32[out + 4] = stats.writeErrors;
    HEAP32[out + 5] = DEFOLD_NETCODE_WEB.inbound.length;
  }
};

autoAddDeps(LibraryDefoldNetcode, '$DEFOLD_NETCODE_WEB');
addToLibrary(LibraryDefoldNetcode);

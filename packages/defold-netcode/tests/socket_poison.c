// Link-time proof that the HOST_DATAGRAM transport reaches no socket syscall.
//
// These strong definitions shadow libc's, so any call aborts the process rather
// than succeeding quietly. Reading netcode.c and concluding that the override
// path skips netcode_socket_create is an argument; this is a measurement.
//
// tests/poison_selftest.c links the same file against a DEFAULT-config server
// and is expected to abort. Without that companion, a pass here would be
// indistinguishable from the poison not being linked in at all.

#include <stdio.h>
#include <stdlib.h>

static void poisoned(const char* name) {
  fprintf(stderr, "FAIL: netcode called %s() on the host-datagram path\n", name);
  abort();
}

// Deliberately not matching libc's prototypes exactly - these are never called
// through a declaration, only resolved by the linker, and matching the real
// signatures would mean pulling in the socket headers this file exists to prove
// unnecessary.
int socket(int domain, int type, int protocol) {
  (void)domain;
  (void)type;
  (void)protocol;
  poisoned("socket");
  return -1;
}

int bind(int fd, const void* address, unsigned int length) {
  (void)fd;
  (void)address;
  (void)length;
  poisoned("bind");
  return -1;
}

long sendto(int fd, const void* buffer, unsigned long length, int flags, const void* address,
            unsigned int address_length) {
  (void)fd;
  (void)buffer;
  (void)length;
  (void)flags;
  (void)address;
  (void)address_length;
  poisoned("sendto");
  return -1;
}

long recvfrom(int fd, void* buffer, unsigned long length, int flags, void* address,
              unsigned int* address_length) {
  (void)fd;
  (void)buffer;
  (void)length;
  (void)flags;
  (void)address;
  (void)address_length;
  poisoned("recvfrom");
  return -1;
}

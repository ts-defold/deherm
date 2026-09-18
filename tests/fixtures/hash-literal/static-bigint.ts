"use strict";

const reportHashLiteral = $SHBuiltin.extern_c(
  {include: "stdint.h"},
  function deherm_hash_literal_static_report(
    low: c_u32,
    high: c_u32,
    equal: c_u32
  ): void { throw 0; }
);

const up: bigint = 0x80356add32e752e9n;
const expected: bigint = 0x80356add32e752e9n;
reportHashLiteral(0x32e752e9, 0x80356add, up === expected ? 1 : 0);

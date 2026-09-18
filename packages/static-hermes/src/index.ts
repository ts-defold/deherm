/// <reference path="./globals.d.ts" />

export { dispatchDmSdkBorrowedHandle } from "./generated/dmsdk-borrowed-handle.js";
export { dispatchDmSdkScratchScalarOut } from "./generated/dmsdk-scratch-scalar-out.js";
export { __ffi_dmsdkUniversalDispatch, DMSDK_UNIVERSAL_MAX_ARGUMENTS, DMSDK_UNIVERSAL_VALUE_BYTES } from "./generated/dmsdk-universal.js";
export {
  DehermStaticValue,
  DehermStaticUndefined,
  DehermStaticNull,
  DehermStaticBoolean,
  DehermStaticNumber,
  DehermStaticString,
  DehermStaticHandle,
  DehermStaticDefoldValue,
  DehermStaticArray,
  DehermStaticRecord,
  DehermStaticMap,
  dispatchScriptUniversalValue
} from "./generated/script-universal-value.js";

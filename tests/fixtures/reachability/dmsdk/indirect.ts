import { callDmSdk, callDmSdkDeclaration } from "@ts-defold/deherm";

callDmSdk.call(null, "~dmArray<T>");
callDmSdkDeclaration.apply(null, [
  "dmsdk:dmGraphics::Finalize@upstream/defold/engine/graphics/src/dmsdk/graphics/graphics.h:1759:1460",
]);
Reflect.apply(callDmSdk, null, ["~dmArray<T>"]);

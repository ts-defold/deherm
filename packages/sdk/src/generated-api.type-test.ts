import {
  callDmSdk,
  go,
  msg,
  relativeAddress,
  type DmPointer,
  type DmSdkTypes,
  type Vector3
} from "./index";

const position: Vector3 = { x: 10, y: 20, z: 0 };
go.setPosition(position);
go.setPosition(position, "#controller");
go.setPosition(position, relativeAddress("player"));

msg.post("#sprite", "enable");
msg.post("main:/level/player#controller", "damage", { amount: 10 });

const arbitraryString: string = "player";
// @ts-expect-error Arbitrary runtime strings must be parsed or explicitly branded as relative addresses.
msg.post(arbitraryString, "enable");

declare const cString: DmPointer<"char">;
const hash64: bigint = callDmSdk("dmHashString64", cString);
void hash64;

const ddfResult: DmSdkTypes["dmDDF::Result"] = 0;
// @ts-expect-error The generated enum contains only public native values.
const invalidDdfResult: DmSdkTypes["dmDDF::Result"] = 42;
void ddfResult;
void invalidDdfResult;

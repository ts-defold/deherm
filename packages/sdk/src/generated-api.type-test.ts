import {
  callDmSdk,
  go,
  msg,
  relativeAddress,
  type DmPointer,
  type DmReadonlyPointer,
  type DmSdkTypes,
  type Vector3,
  vmath
} from "./index";

const position: Vector3 = vmath.vector3(10, 20, 0);
const clampedPosition: Vector3 = vmath.clamp(position, position, position);
const interpolatedPosition: Vector3 = vmath.lerp(0.5, position, position);
void clampedPosition;
void interpolatedPosition;
go.setPosition(position);
go.setPosition(position, "#controller");
go.setPosition(position, relativeAddress("player"));

msg.post("#sprite", "enable");
msg.post("main:/level/player#controller", "damage", { amount: 10 });

const arbitraryString: string = "player";
// @ts-expect-error Arbitrary runtime strings must be parsed or explicitly branded as relative addresses.
msg.post(arbitraryString, "enable");

declare const cString: DmPointer<"char">;
const readonlyCString: DmReadonlyPointer<"char"> = cString;
const hash64: bigint = callDmSdk("dmHashString64", cString);
void readonlyCString;
void hash64;

declare const ddfBuffer: DmReadonlyPointer<"void">;
declare const ddfDescriptor: DmReadonlyPointer<"dmDDF::Descriptor">;
declare const ddfMessage: DmPointer<"void">;
const loadedMessage: DmSdkTypes["dmDDF::Result"] = callDmSdk(
  "dmDDF::LoadMessage",
  ddfBuffer,
  128,
  ddfDescriptor,
  ddfMessage,
);
void loadedMessage;

const ddfResult: DmSdkTypes["dmDDF::Result"] = 0;
// @ts-expect-error The generated enum contains only public native values.
const invalidDdfResult: DmSdkTypes["dmDDF::Result"] = 42;
void ddfResult;
void invalidDdfResult;

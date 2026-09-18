import {
  address,
  defoldUrl,
  relativeAddress,
  type DefoldAddress,
  type DefoldHash
} from "./address";

const accepted: DefoldAddress[] = [
  ".",
  "#",
  "#sprite",
  "player#sprite",
  "/level/player",
  "/level/player#sprite",
  "main:/level/player#sprite",
  "@render:",
  relativeAddress("player")
];

address("#sprite");
address("main:/level/player#sprite");

// @ts-expect-error Bare relative ids require relativeAddress() so arbitrary strings do not pass silently.
const invalidBareAddress: DefoldAddress = "player";
// @ts-expect-error A structured address must contain a recognized delimiter or shorthand.
address("player");
// @ts-expect-error relativeAddress() only accepts a bare identifier, not a URL or fragment.
relativeAddress("player#sprite");

void accepted;
void invalidBareAddress;

const exactUrl = defoldUrl(1n as DefoldHash, 2n as DefoldHash, 3n as DefoldHash,
  0x13579bdf2468ace0n as DefoldHash);
void exactUrl.reserved;

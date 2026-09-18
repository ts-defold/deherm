import {
  DehermStaticArray,
  DehermStaticBoolean,
  DehermStaticNumber,
  DehermStaticRecord,
  DehermStaticString,
  type DehermStaticValue
} from "../../packages/static-hermes/src/index.js";

const nested: DehermStaticValue[] = [
  new DehermStaticBoolean(true),
  new DehermStaticNumber(42)
];
const record: DehermStaticValue = new DehermStaticRecord(
  ["name", "values"],
  [new DehermStaticString("basalt"), new DehermStaticArray(nested)]
);

void record;

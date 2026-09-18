import {
  type B2Body,
  type B2Joint,
  type DefoldHandle,
  type Node,
  type Texture,
} from "./index";

declare const body: B2Body;
declare const joint: B2Joint;
declare const node: Node;
declare const texture: Texture;

body.dispose();
joint.dispose();
node.dispose();
texture.dispose();

const semanticBody: DefoldHandle<"box2d-body"> = body;
void semanticBody;

// @ts-expect-error Distinct Defold engine handle kinds are not interchangeable.
const jointFromBody: B2Joint = body;
// @ts-expect-error Numeric graphics handles retain their semantic kind brand.
const textureFromNode: Texture = node;
void jointFromBody;
void textureFromNode;

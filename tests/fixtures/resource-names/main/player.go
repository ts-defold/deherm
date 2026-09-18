components {
  id: "typo"
  component: "/main/typo.script"
}
components {
  id: "player"
  component: "/main/player.script"
}
embedded_components {
  id: "sprite"
  type: "sprite"
  data: "tile_set: \"/main/units.atlas\"\n"
  "default_animation: \"idle\"\n"
  "material: \"/builtins/materials/sprite.material\"\n"
  ""
}
embedded_components {
  id: "shooter"
  type: "factory"
  data: "prototype: \"/main/bullet.go\"\n"
  ""
}

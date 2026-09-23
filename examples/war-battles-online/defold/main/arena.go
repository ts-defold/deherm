components {
  id: "arena"
  component: "/main/arena.script"
}
embedded_components {
  id: "tankfactory"
  type: "factory"
  data: "prototype: \"/main/arena-tank.go\"\n"
  "load_dynamically: false\n"
  ""
  position {
    x: 0.0
    y: 0.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
}
embedded_components {
  id: "pickupfactory"
  type: "factory"
  data: "prototype: \"/main/arena-pickup.go\"\n"
  "load_dynamically: false\n"
  ""
  position {
    x: 0.0
    y: 0.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
}
embedded_components {
  id: "shotfactory"
  type: "factory"
  data: "prototype: \"/main/arena-shot.go\"\n"
  "load_dynamically: false\n"
  ""
  position {
    x: 0.0
    y: 0.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
}
embedded_components {
  id: "boomfactory"
  type: "factory"
  data: "prototype: \"/main/arena-boom.go\"\n"
  "load_dynamically: false\n"
  ""
  position {
    x: 0.0
    y: 0.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
}
embedded_components {
  id: "sparkfactory"
  type: "factory"
  data: "prototype: \"/main/arena-spark.go\"\n"
  "load_dynamically: false\n"
  ""
  position {
    x: 0.0
    y: 0.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
}
embedded_components {
  id: "sfx_fire"
  type: "sound"
  data: "sound: \"/assets/derived/audio/fire.wav\"\n"
  "looping: 0\n"
  "group: \"soundfx\"\n"
  "gain: 0.55\n"
  ""
}
embedded_components {
  id: "sfx_hit"
  type: "sound"
  data: "sound: \"/assets/derived/audio/hit.wav\"\n"
  "looping: 0\n"
  "group: \"soundfx\"\n"
  "gain: 0.45\n"
  ""
}
embedded_components {
  id: "sfx_explosion"
  type: "sound"
  data: "sound: \"/assets/derived/audio/explosion.wav\"\n"
  "looping: 0\n"
  "group: \"soundfx\"\n"
  "gain: 0.65\n"
  ""
}
embedded_components {
  id: "sfx_pickup"
  type: "sound"
  data: "sound: \"/assets/derived/audio/pickup.wav\"\n"
  "looping: 0\n"
  "group: \"soundfx\"\n"
  "gain: 0.55\n"
  ""
}
embedded_components {
  id: "sfx_round"
  type: "sound"
  data: "sound: \"/assets/derived/audio/round.wav\"\n"
  "looping: 0\n"
  "group: \"soundfx\"\n"
  "gain: 0.55\n"
  ""
}

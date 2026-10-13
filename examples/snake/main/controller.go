components {
  id: "snake"
  component: "/main/snake.script"
}
embedded_components {
  id: "head_factory"
  type: "factory"
  data: "prototype: \"/main/head.go\"\n"
  "load_dynamically: false\n"
  ""
}
embedded_components {
  id: "body_factory"
  type: "factory"
  data: "prototype: \"/main/body.go\"\n"
  "load_dynamically: false\n"
  ""
}
embedded_components {
  id: "food_factory"
  type: "factory"
  data: "prototype: \"/main/food.go\"\n"
  "load_dynamically: false\n"
  ""
}

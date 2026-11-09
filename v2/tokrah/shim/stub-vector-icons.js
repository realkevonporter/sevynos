const React = require("react");
// SevynOS M6 — @expo/vector-icons stub. Icons render as a text
// glyph (the icon name's first letter) — the font files never load.
function makeIcon(setName) {
  function Icon(props) {
    const name = (props && props.name) || "?";
    return React.createElement(
      "Text",
      {
        style: [
          {
            fontSize: (props && props.size) || 20,
            color: (props && props.color) || "#000000",
          },
          props && props.style,
        ],
      },
      String(name).charAt(0).toUpperCase(),
    );
  }
  Icon.__setName = setName;
  return Icon;
}
const sets = [
  "Ionicons",
  "MaterialCommunityIcons",
  "MaterialIcons",
  "FontAwesome",
  "FontAwesome5",
  "FontAwesome6",
  "Feather",
  "Entypo",
  "EvilIcons",
  "Octicons",
  "AntDesign",
  "SimpleLineIcons",
  "Zocial",
  "Foundation",
];
const out = {};
for (const s of sets) out[s] = makeIcon(s);
module.exports = out;

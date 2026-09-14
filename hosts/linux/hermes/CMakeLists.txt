set(HERMES_ENABLE_EH ON)

add_hermes_tool(sevyn-hermes-host
  main.cpp
  LINK_OBJLIBS hermesvm_a
)

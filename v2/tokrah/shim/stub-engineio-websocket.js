// SevynOS M6 — engine.io-client WebSocket transport stand-in.
//
// The SevynOS host has no WebSocket (a real host adapter is a later
// milestone, not M6). engine.io-client uses transports[0] for the
// initial connect and never falls back to the next transport when it
// fails — so a present-but-broken WS class makes the socket retry
// WebSocket forever and never try polling. This module exports no WS
// class, so the Socket's `.filter((t) => !!t)` drops "websocket" from
// the list and polling (the shim's XHR over `sevyn net fetch`) becomes
// the initial transport.

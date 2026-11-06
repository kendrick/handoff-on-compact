# Clean Room From handoff-compact

`trytofly94/handoff-compact` already answers `session.compact` with a fork-written handoff, so forking it looks like the obvious move. We built this plugin from its README's description alone, without reading its hooks or tests and without reusing its names, because we wanted the implementation to come from our own toolchain. The `handoff` skill owns the handoff document's outline, and the plugin only drives it. Don't port code or option names from handoff-compact; that would undo this decision.

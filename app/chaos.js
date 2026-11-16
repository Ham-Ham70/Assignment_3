// Shared in-process fault-injection state for the slow-request / least-request
// experiments. The HTTP middleware and the gRPC wrapper both consult this, so a
// single POST /chaos/delay on a replica slows that replica on BOTH interfaces.
//
// State lives in the process, so it is per replica and disappears on restart.

const state = {
  delayEveryNth: 0,
  delayMs: 0,
  requestOrdinal: 0,
};

function configure(every, ms) {
  state.delayEveryNth = Number(every) || 0;
  state.delayMs = Number(ms) || 0;
  state.requestOrdinal = 0;
}

function clear() {
  configure(0, 0);
}

// Delay (ms) to apply to the next request; 0 means no delay. Counts across both
// interfaces so "every Nth request" is honest per replica.
function nextDelayMs() {
  if (state.delayEveryNth <= 0 || state.delayMs <= 0) return 0;
  state.requestOrdinal += 1;
  return state.requestOrdinal % state.delayEveryNth === 0 ? state.delayMs : 0;
}

module.exports = { state, configure, clear, nextDelayMs };

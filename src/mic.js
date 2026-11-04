// Mic echo reduction for the entrance hall (sample for issue #12)

const ECHO_GATE = 0.35; // ignore mic input below this level while jiji is speaking

function shouldListen(micLevel, jijiIsSpeaking) {
  if (jijiIsSpeaking && micLevel < ECHO_GATE) return false; // likely jiji's own voice echoing
  return true;
}

console.log(shouldListen(0.2, true));  // false: echo ignored
console.log(shouldListen(0.8, true));  // true: a visitor talking over jiji
console.log(shouldListen(0.2, false)); // true: jiji is quiet, listen normally

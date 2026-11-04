// Sample code for testing the Backlog <-> GitHub link.
// Edit anything here, commit with a Backlog issue key, and push.

function greet(visitorName) {
  return `いらっしゃいませ、${visitorName}様。jijiがご案内します。`;
}

console.log(greet("テスト"));

// Voice + screen: show subtitles while jiji speaks
const GREETING_PAUSE_SEC = 0.3; // was 1.0: jiji starts speaking a little bit sooner

function speakWithSubtitle(text) {
  console.log(`[screen] ${text}`);
  console.log(`[voice ] (after ${GREETING_PAUSE_SEC}s) ${text}`);
}

speakWithSubtitle(greet("テスト"));

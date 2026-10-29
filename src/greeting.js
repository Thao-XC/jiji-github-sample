// Sample code for testing the Backlog <-> GitHub link.
// Edit anything here, commit with a Backlog issue key, and push.

function greet(visitorName) {
  return `いらっしゃいませ、${visitorName}様。jijiがご案内します。`;
}

console.log(greet("テスト"));

// Voice + screen: show subtitles while jiji speaks
function speakWithSubtitle(text) {
  console.log(`[screen] ${text}`);
  console.log(`[voice ] ${text}`);
}

speakWithSubtitle(greet("テスト"));

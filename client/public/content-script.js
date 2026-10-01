// client/public/content-script.js
console.log('⚡ LeetSync Content Script Active on LeetCode!');

let isSyncing = false;
let pendingSubmitAt = 0;
let lastHandledSubmissionId = null;

const SUBMIT_SELECTOR = '[data-e2e-locator="console-submit-button"]';

const LANGUAGE_EXTENSIONS = {
  cpp: 'cpp',
  java: 'java',
  python: 'py',
  python3: 'py',
  c: 'c',
  csharp: 'cs',
  javascript: 'js',
  typescript: 'ts',
  golang: 'go',
  rust: 'rs',
  kotlin: 'kt',
  swift: 'swift',
  ruby: 'rb',
  scala: 'scala',
  php: 'php',
  dart: 'dart',
  mysql: 'sql',
  mssql: 'sql',
  oraclesql: 'sql',
  postgresql: 'sql',
};

function showLeetCodeToast(message, isError = false) {
  const existing = document.getElementById('leetsync-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'leetsync-toast';
  toast.innerText = message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    backgroundColor: isError ? '#ef4444' : '#10b981',
    color: '#ffffff',
    padding: '12px 20px',
    borderRadius: '8px',
    fontWeight: '600',
    fontSize: '14px',
    zIndex: '999999',
    boxShadow: '0 8px 20px rgba(0, 0, 0, 0.35)',
    fontFamily: 'Inter, system-ui, sans-serif',
    transition: 'opacity 0.3s ease',
  });

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function getTitleSlug() {
  const match = window.location.pathname.match(/\/problems\/([^/]+)/);
  return match ? match[1] : null;
}

async function fetchProblemData(titleSlug) {
  const query = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionFrontendId
        title
        titleSlug
        difficulty
        content
      }
    }
  `;

  const response = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query, variables: { titleSlug } }),
  });

  const json = await response.json();
  return json?.data?.question;
}

async function fetchLatestAcceptedSubmission(titleSlug) {
  const listQuery = `
    query submissionList($questionSlug: String!) {
      questionSubmissionList(questionSlug: $questionSlug, offset: 0, limit: 5, status: 10) {
        submissions {
          id
          title
          statusDisplay
          lang
          langName
          runtime
          memory
          timestamp
        }
      }
    }
  `;

  const listRes = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query: listQuery, variables: { questionSlug: titleSlug } }),
  });

  const listJson = await listRes.json();
  const latest = listJson?.data?.questionSubmissionList?.submissions?.[0];
  if (!latest) return null;

  const detailQuery = `
    query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code
        runtimeDisplay
        runtimePercentile
        memoryDisplay
        memoryPercentile
      }
    }
  `;

  const detailRes = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      query: detailQuery,
      variables: { submissionId: Number(latest.id) },
    }),
  });

  const detailJson = await detailRes.json();
  return {
    ...latest,
    ...detailJson?.data?.submissionDetails,
  };
}

async function waitForNewSubmission(titleSlug) {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 800 : 1000));
    const sub = await fetchLatestAcceptedSubmission(titleSlug);
    if (sub && sub.id !== lastHandledSubmissionId) return sub;
  }
  return null;
}

async function markSubmissionStarted() {
  pendingSubmitAt = Date.now();
  const titleSlug = getTitleSlug();
  if (!titleSlug || !chrome.runtime?.id) return;

  const pendingData = {
    titleSlug,
    submittedAt: Math.floor(Date.now() / 1000),
  };

  await chrome.storage.local.set({ pendingSubmission: pendingData });
  chrome.runtime.sendMessage({
    action: 'WATCH_PENDING_SUBMISSION',
    payload: pendingData,
  });
}

document.addEventListener(
  'click',
  (e) => {
    if (e.target.closest?.(SUBMIT_SELECTOR)) markSubmissionStarted();
  },
  true
);

document.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') markSubmissionStarted();
  },
  true
);

async function handleAcceptedSubmission() {
  if (isSyncing || !chrome.runtime?.id) return;

  const titleSlug = getTitleSlug();
  if (!titleSlug) return;

  try {
    isSyncing = true;

    const [problem, submission] = await Promise.all([
      fetchProblemData(titleSlug),
      waitForNewSubmission(titleSlug),
    ]);

    const submissionAgeInSeconds = submission?.timestamp
      ? Date.now() / 1000 - Number(submission.timestamp)
      : Infinity;

    if (!problem || !submission || !submission.code || submissionAgeInSeconds > 60) {
      showLeetCodeToast('⚠️ LeetSync: No recent verified Accepted submission found.', true);
      isSyncing = false;
      return;
    }

    lastHandledSubmissionId = submission.id;

    const paddedId = String(problem.questionFrontendId).padStart(4, '0');
    const folderName = `${paddedId}-${problem.titleSlug}`;
    const ext = LANGUAGE_EXTENSIONS[submission.lang] || 'txt';

    const runtime = submission.runtimeDisplay || submission.runtime || 'N/A';
    const memory = submission.memoryDisplay || submission.memory || 'N/A';
    const runtimeBeats = submission.runtimePercentile
      ? `${submission.runtimePercentile.toFixed(2)}%`
      : 'N/A';
    const memoryBeats = submission.memoryPercentile
      ? `${submission.memoryPercentile.toFixed(2)}%`
      : 'N/A';

    const commentPrefix = ['py', 'rb', 'sql'].includes(ext) ? '#' : '//';
    const headerComment = [
      `${commentPrefix} Problem: ${problem.questionFrontendId}. ${problem.title} (${problem.difficulty})`,
      `${commentPrefix} URL: https://leetcode.com/problems/${problem.titleSlug}/`,
      `${commentPrefix} Runtime: ${runtime} (Beats ${runtimeBeats})`,
      `${commentPrefix} Memory: ${memory} (Beats ${memoryBeats})`,
      '',
    ].join('\n');

    const formattedCode = `${headerComment}\n${submission.code}\n`;
    const readmeContent = `# [${problem.questionFrontendId}. ${problem.title}](https://leetcode.com/problems/${problem.titleSlug}/)\n\n**Difficulty:** ${problem.difficulty}\n\n---\n\n${problem.content || ''}\n`;

    await chrome.storage.local.remove('pendingSubmission');

    showLeetCodeToast(`⏳ LeetSync: Checking & syncing ${paddedId}. ${problem.title}...`);

    chrome.runtime.sendMessage(
      {
        action: 'PUSH_LEETCODE_SOLUTION',
        payload: {
          folderName,
          fileName: `solution.${ext}`,
          code: formattedCode,
          rawCode: submission.code,
          readmeContent,
          problemId: paddedId,
          problemTitle: problem.title,
          language: submission.langName || submission.lang,
          runtime,
          runtimeBeats,
          memory,
          memoryBeats,
        },
      },
      (response) => {
        isSyncing = false;
        if (chrome.runtime.lastError) {
          showLeetCodeToast(`❌ LeetSync Error: ${chrome.runtime.lastError.message}`, true);
          return;
        }
        if (response?.success) {
          if (response.skipped) {
            showLeetCodeToast('ℹ️ LeetSync: Identical solution already in GitHub!');
          } else {
            showLeetCodeToast('✅ Successfully pushed to GitHub!');
          }
        } else {
          showLeetCodeToast(`❌ LeetSync: ${response?.error || 'Push failed'}`, true);
        }
      }
    );
  } catch (err) {
    isSyncing = false;
    console.warn('LeetSync Extraction Warning:', err);
  }
}

const observer = new MutationObserver(() => {
  if (!chrome.runtime?.id) {
    observer.disconnect();
    return;
  }
  if (!pendingSubmitAt || Date.now() - pendingSubmitAt > 60000) return;

  const el = document.querySelector('[data-e2e-locator="submission-result"]');
  if (el && el.textContent?.trim() === 'Accepted' && !isSyncing) {
    pendingSubmitAt = 0;
    handleAcceptedSubmission();
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});
const BG_LANG_EXT = {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'AUTHENTICATE_GITHUB') {
    handleGitHubOAuth(message.clientId, message.clientSecret)
      .then((userData) => sendResponse({ success: true, ...userData }))
      .catch(async (error) => {
        await chrome.storage.local.set({ authDebugStatus: 'ERROR: ' + error.message });
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'PUSH_LEETCODE_SOLUTION') {
    pushSolutionToGitHub(message.payload)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'WATCH_PENDING_SUBMISSION') {
    pollPendingSubmissionInBackground(message.payload, sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }
});


function toBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function fromBase64(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

function stripLeetSyncHeader(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const headerRegex = /^(?:(?:\/\/|#)\s*Problem:.*\n(?:\/\/|#)\s*URL:.*\n(?:\/\/|#)\s*Runtime:.*\n(?:\/\/|#)\s*Memory:.*\n\n?)/;
  return normalized.replace(headerRegex, '').trim();
}

async function handleUnauthorizedToken() {
  await chrome.storage.local.remove(['isAuthenticated', 'githubToken', 'githubUsername']);
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
}

async function ensureRepoExists(owner, repo, token) {
  const checkRes = await fetch('https://api.github.com/repos/' + owner + '/' + repo, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
    },
  });

  if (checkRes.status === 401) {
    await handleUnauthorizedToken();
    throw new Error('GitHub token expired/revoked (401). Please re-authenticate.');
  }

  if (checkRes.status === 404) {
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repo,
        description: 'Automated LeetCode solutions synced via LeetSync ⚡',
        private: false,
        auto_init: true,
      }),
    });

    if (createRes.status === 401) {
      await handleUnauthorizedToken();
      throw new Error('GitHub token expired/revoked (401). Please re-authenticate.');
    }

    if (!createRes.ok) {
      throw new Error('Could not find or create repository "' + repo + '".');
    }
  } else if (!checkRes.ok) {
    throw new Error('Failed to verify repository "' + repo + '" (HTTP ' + checkRes.status + ').');
  }
}

async function getExistingFile(owner, repo, path, token) {
  const res = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
    },
  });

  if (res.status === 401) {
    await handleUnauthorizedToken();
    throw new Error('GitHub token expired/revoked (401). Please re-authenticate.');
  }

  if (res.status === 404) return null;
  if (!res.ok) throw new Error('GitHub GET failed (' + res.status + ') for ' + path);

  const data = await res.json();
  return {
    sha: data.sha,
    content: fromBase64(data.content),
  };
}

async function upsertGitHubFile(owner, repo, path, content, commitMessage, token, sha = null) {
  const body = {
    message: commitMessage,
    content: toBase64(content),
  };
  if (sha) body.sha = sha;

  const res = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    await handleUnauthorizedToken();
    throw new Error('GitHub token expired/revoked (401). Please re-authenticate.');
  }

  if (!res.ok) {
    const errData = await res.json();
    throw new Error(errData.message || 'Failed to push ' + path + ' to GitHub.');
  }

  return res.json();
}

async function updateGlobalReadme(owner, repo, payload, token) {
  const globalReadmePath = 'README.md';
  const existing = await getExistingFile(owner, repo, globalReadmePath, token);

  const problemsMap = new Map();

  if (existing && existing.content) {
    const lines = existing.content.split('\n');
    for (const line of lines) {
      const bulletMatch = line.trim().match(/^-\s+\*\*(\d{4})\.\*\*/);
      if (bulletMatch) {
        problemsMap.set(bulletMatch[1], line.trim());
      }
    }

    const oldTableRegex = /\[([^\]]+)\]\(\.\/((\d{4})-[^)]+)\)/g;
    let match;
    while ((match = oldTableRegex.exec(existing.content)) !== null) {
      const title = match[1];
      const folder = match[2];
      const id = match[3];
      if (!problemsMap.has(id)) {
        problemsMap.set(id, '- **' + id + '.** [' + title + '](./' + folder + ') — **C++**');
      }
    }
  }

  const currentBullet =
    '- **' +
    payload.problemId +
    '.** [' +
    payload.problemTitle +
    '](./' +
    payload.folderName +
    ') — **' +
    payload.language +
    '** • Runtime: ' +
    payload.runtime +
    ' (Beats ' +
    payload.runtimeBeats +
    ') • Memory: ' +
    (payload.memory || 'N/A') +
    ' (Beats ' +
    (payload.memoryBeats || 'N/A') +
    ')';

  if (existing && existing.content.includes(currentBullet) && !existing.content.includes('---')) {
    return;
  }

  problemsMap.set(payload.problemId, currentBullet);

  const sortedBullets = Array.from(problemsMap.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map((entry) => entry[1]);

  const solvedCount = sortedBullets.length;
  const label = solvedCount === 1 ? 'Problem' : 'Problems';

  const newContent = [
    '# ⚡ LeetCode Solutions',
    '',
    'Auto-synced via **LeetSync**',
    '',
    '### 📊 Global Stats: ' + solvedCount + ' ' + label + ' Solved',
    '',
    '### ✅ Solved Problems',
    '',
    ...sortedBullets,
    '',
  ].join('\n');

  await upsertGitHubFile(
    owner,
    repo,
    globalReadmePath,
    newContent,
    'Stats: Update global README for ' + payload.problemId + '. ' + payload.problemTitle,
    token,
    existing?.sha || null
  );
}

async function pushSolutionToGitHub(payload) {
  const storage = await chrome.storage.local.get([
    'isAuthenticated',
    'githubToken',
    'githubUsername',
    'repoName',
  ]);

  if (!storage.isAuthenticated || !storage.githubToken || !storage.githubUsername) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    throw new Error('Not authenticated. Open LeetSync popup to link GitHub.');
  }

  const owner = storage.githubUsername;
  const repo = (storage.repoName || 'my-leetcode-solutions').trim();
  const token = storage.githubToken;

  await ensureRepoExists(owner, repo, token);

  const solutionPath = payload.folderName + '/' + payload.fileName;
  const readmePath = payload.folderName + '/README.md';

  const existingSolution = await getExistingFile(owner, repo, solutionPath, token);

  if (existingSolution) {
    const existingRaw = stripLeetSyncHeader(existingSolution.content);
    const incomingRaw = payload.rawCode.replace(/\r\n/g, '\n').trim();

    if (existingRaw === incomingRaw) {
      await updateGlobalReadme(owner, repo, payload, token);
      await chrome.storage.local.set({
        lastSynced: payload.problemId + '. ' + payload.problemTitle + ' (' + payload.language + ')',
      });
      return { skipped: true };
    }
  }

  const existingReadme = await getExistingFile(owner, repo, readmePath, token);
  if (!existingReadme && payload.readmeContent) {
    await upsertGitHubFile(
      owner,
      repo,
      readmePath,
      payload.readmeContent,
      'Docs: Add problem description for ' + payload.problemId + '. ' + payload.problemTitle,
      token
    );
  }

  const commitPrefix = existingSolution ? 'Update solution' : 'Auto-commit: Solved';
  const memoryStat = payload.memory
    ? ', Memory: ' + payload.memory + ' (Beats ' + (payload.memoryBeats || 'N/A') + ')'
    : '';
  const commitMessage =
    commitPrefix +
    ' ' +
    payload.problemId +
    '. ' +
    payload.problemTitle +
    ' in ' +
    payload.language +
    ' (Runtime: ' +
    payload.runtime +
    ' (Beats ' +
    payload.runtimeBeats +
    ')' +
    memoryStat +
    ')';

  await upsertGitHubFile(
    owner,
    repo,
    solutionPath,
    payload.code,
    commitMessage,
    token,
    existingSolution?.sha || null
  );

  await updateGlobalReadme(owner, repo, payload, token);
  await chrome.storage.local.set({
    lastSynced: payload.problemId + '. ' + payload.problemTitle + ' (' + payload.language + ')',
  });

  return { skipped: false };
}

async function pollPendingSubmissionInBackground({ titleSlug, submittedAt }, tabId) {
  const listQuery = [
    'query submissionList($questionSlug: String!) {',
    '  questionSubmissionList(questionSlug: $questionSlug, offset: 0, limit: 3, status: 10) {',
    '    submissions { id title lang langName runtime memory timestamp }',
    '  }',
    '}',
  ].join('\n');

  const detailQuery = [
    'query bgDetails($titleSlug: String!, $submissionId: Int!) {',
    '  question(titleSlug: $titleSlug) {',
    '    questionFrontendId title titleSlug difficulty content',
    '  }',
    '  submissionDetails(submissionId: $submissionId) {',
    '    code runtimeDisplay runtimePercentile memoryDisplay memoryPercentile',
    '  }',
    '}',
  ].join('\n');

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { pendingSubmission } = await chrome.storage.local.get(['pendingSubmission']);
    if (!pendingSubmission || pendingSubmission.submittedAt !== submittedAt) {
      return;
    }

    if (tabId) {
      try {
        await chrome.tabs.get(tabId);
        continue;
      } catch {

      }
    }

    try {
      const listRes = await fetch('https://leetcode.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query: listQuery, variables: { questionSlug: titleSlug } }),
      });
      const listJson = await listRes.json();
      const latest = listJson?.data?.questionSubmissionList?.submissions?.[0];

      if (!latest || Number(latest.timestamp) < submittedAt - 10) continue;

      const detailRes = await fetch('https://leetcode.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          query: detailQuery,
          variables: { titleSlug, submissionId: Number(latest.id) },
        }),
      });

      const detailJson = await detailRes.json();
      const problem = detailJson?.data?.question;
      const details = detailJson?.data?.submissionDetails;
      if (!problem || !details?.code) return;

      const paddedId = String(problem.questionFrontendId).padStart(4, '0');
      const ext = BG_LANG_EXT[latest.lang] || 'txt';
      const runtime = details.runtimeDisplay || latest.runtime || 'N/A';
      const memory = details.memoryDisplay || latest.memory || 'N/A';
      const runtimeBeats = details.runtimePercentile
        ? details.runtimePercentile.toFixed(2) + '%'
        : 'N/A';
      const memoryBeats = details.memoryPercentile
        ? details.memoryPercentile.toFixed(2) + '%'
        : 'N/A';
      const commentPrefix = ['py', 'rb', 'sql'].includes(ext) ? '#' : '//';

      const formattedCode = [
        commentPrefix + ' Problem: ' + problem.questionFrontendId + '. ' + problem.title + ' (' + problem.difficulty + ')',
        commentPrefix + ' URL: https://leetcode.com/problems/' + problem.titleSlug + '/',
        commentPrefix + ' Runtime: ' + runtime + ' (Beats ' + runtimeBeats + ')',
        commentPrefix + ' Memory: ' + memory + ' (Beats ' + memoryBeats + ')',
        '',
        details.code,
        '',
      ].join('\n');

      const readmeContent = [
        '# [' + problem.questionFrontendId + '. ' + problem.title + '](https://leetcode.com/problems/' + problem.titleSlug + '/)',
        '',
        '**Difficulty:** ' + problem.difficulty,
        '',
        '---',
        '',
        problem.content || '',
        '',
      ].join('\n');

      await chrome.storage.local.remove('pendingSubmission');

      await pushSolutionToGitHub({
        folderName: paddedId + '-' + problem.titleSlug,
        fileName: 'solution.' + ext,
        code: formattedCode,
        rawCode: details.code,
        readmeContent,
        problemId: paddedId,
        problemTitle: problem.title,
        language: latest.langName || latest.lang,
        runtime,
        runtimeBeats,
        memory,
        memoryBeats,
      });

      return;
    } catch (err) {
      console.warn('Background poll attempt failed:', err);
    }
  }
}

async function handleGitHubOAuth(passedClientId, passedClientSecret) {
  const clientId = passedClientId || GITHUB_CLIENT_ID;
  const clientSecret = passedClientSecret || GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret || clientSecret === 'YOUR_GITHUB_CLIENT_SECRET') {
    throw new Error('Missing GitHub OAuth credentials in client/.env file.');
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    'https://github.com/login/oauth/authorize' +
    '?client_id=' +
    clientId +
    '&redirect_uri=' +
    encodeURIComponent(redirectUri) +
    '&scope=repo';

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  if (!responseUrl) throw new Error('Login window was closed before finishing.');

  const url = new URL(responseUrl);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('No code returned from GitHub.');

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || 'Failed to get token.');
  }

  const accessToken = tokenData.access_token;

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!userResponse.ok) throw new Error('Failed to fetch GitHub user profile.');
  const userProfile = await userResponse.json();

  await chrome.storage.local.set({
    githubToken: accessToken,
    githubUsername: userProfile.login,
    isAuthenticated: true,
  });

  chrome.action.setBadgeText({ text: '' });
  return { githubUsername: userProfile.login };
}
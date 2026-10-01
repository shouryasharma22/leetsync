import { useState, useEffect } from 'react';
import './App.css';

interface StorageData {
  isAuthenticated?: boolean;
  githubUsername?: string;
  githubToken?: string;
  repoName?: string;
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [githubUsername, setGithubUsername] = useState<string>('');
  const [repoName, setRepoName] = useState<string>('my-leetcode-solutions');
  const [statusMessage, setStatusMessage] = useState<string>('Checking status...');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // 1. Load saved state from chrome.storage.local when popup opens
  useEffect(() => {
    chrome.storage.local.get(
      ['isAuthenticated', 'githubUsername', 'githubToken', 'repoName'],
      async (result: StorageData) => {
        if (result.repoName) {
          setRepoName(result.repoName);
        }

        if (result.isAuthenticated && result.githubToken && result.githubUsername) {
          // Validate that the token hasn't expired or been revoked
          const isValid = await verifyGitHubToken(result.githubToken);
          if (isValid) {
            setIsAuthenticated(true);
            setGithubUsername(result.githubUsername);
            setStatusMessage('Account Linked');
          } else {
            // Token was revoked -> clear auth & show warning badge
            await handleUnlink('Session expired (401). Please re-authenticate.');
            chrome.action.setBadgeText({ text: '!' });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
          }
        } else {
          setStatusMessage('Account Unlinked');
        }
      }
    );
  }, []);

  // Verify token validity against GitHub API
  const verifyGitHubToken = async (token: string): Promise<boolean> => {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.status !== 401;
    } catch {
      return true; // Don't log out on temporary offline network hiccups
    }
  };

  // 2. Trigger OAuth flow via Background Service Worker
  const handleAuthenticate = () => {
    setIsLoading(true);
    setStatusMessage('Opening GitHub login...');

    chrome.runtime.sendMessage(
      {
        action: 'AUTHENTICATE_GITHUB',
        clientId: import.meta.env.VITE_GITHUB_CLIENT_ID,
        clientSecret: import.meta.env.VITE_GITHUB_CLIENT_SECRET,
      },
      (response) => {
        setIsLoading(false);

        if (chrome.runtime.lastError) {
          setStatusMessage(`Error: ${chrome.runtime.lastError.message}`);
          return;
        }

        if (response && response.success) {
          setIsAuthenticated(true);
          setGithubUsername(response.githubUsername);
          setStatusMessage('Account Linked');
        } else {
          setStatusMessage(`Auth failed: ${response?.error || 'Unknown error'}`);
        }
      }
    );
  };

  // 3. Unlink / Logout handler
  const handleUnlink = async (customMessage = 'Account Unlinked') => {
    await chrome.storage.local.remove(['isAuthenticated', 'githubUsername', 'githubToken']);
    setIsAuthenticated(false);
    setGithubUsername('');
    setStatusMessage(customMessage);
  };

  // 4. Persist Target Repository changes immediately to chrome.storage.local
  const handleRepoChange = (newRepo: string) => {
    setRepoName(newRepo);
    chrome.storage.local.set({ repoName: newRepo });
  };

  return (
    <div className="popup-container">
      {/* Branding: big & centered when unlinked, compact top-left when linked */}
      {isAuthenticated ? (
        <header className="brand brand-compact">
          <img className="brand-logo" src="/logo.png" alt="" />
          <img className="brand-wordmark" src="/wordmark.png" alt="LeetSync" />
        </header>
      ) : (
        <header className="brand brand-hero">
          <img className="brand-logo" src="/logo.png" alt="" />
          <img className="brand-wordmark" src="/wordmark.png" alt="LeetSync" />
          <p className="brand-tagline">Push your leetcode submissions to github</p>
        </header>
      )}

      {/* Account card (linked only) */}
      {isAuthenticated && (
        <section className="card account-info">
          <p>
            <strong>Account:</strong> @{githubUsername}
          </p>
          <p>
            <strong>Linked Repo:</strong>
          </p>
          <p>
            {githubUsername}/{repoName}
          </p>
          <button className="btn-danger" onClick={() => handleUnlink()}>
            Unlink Github Account
          </button>
        </section>
      )}

      {/* Target Repository */}
      <section className="card">
        <label htmlFor="repo-input">Target Repository</label>
        <input
          id="repo-input"
          type="text"
          value={repoName}
          onChange={(e) => handleRepoChange(e.target.value)}
          placeholder="e.g., my-leetcode-solutions"
        />
      </section>

      {/* Authenticate button (unlinked only) */}
      {!isAuthenticated && (
        <button className="btn-primary" onClick={handleAuthenticate} disabled={isLoading}>
          {isLoading ? 'Authenticating...' : 'Authenticate account with GitHub'}
        </button>
      )}

      <p className="status-text">Status: {statusMessage}</p>
    </div>
  );
}

export default App;

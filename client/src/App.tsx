import { useState, useEffect } from 'react';
import './App.css';

interface StorageData {
  isAuthenticated?: boolean;
  githubUsername?: string;
  githubToken?: string;
  repoName?: string;
}

function App() {
  const [isCheckingStorage, setIsCheckingStorage] = useState<boolean>(true);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [githubUsername, setGithubUsername] = useState<string>('');
  const [repoName, setRepoName] = useState<string>('my-leetcode-solutions');
  const [statusMessage, setStatusMessage] = useState<string>('Checking status...');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    chrome.storage.local.get(
      ['isAuthenticated', 'githubUsername', 'githubToken', 'repoName'],
      async (result: StorageData) => {
        if (result.repoName) {
          setRepoName(result.repoName);
        }

        if (result.isAuthenticated && result.githubToken && result.githubUsername) {
          setIsAuthenticated(true);
          setGithubUsername(result.githubUsername);
          setStatusMessage('Account Linked');
          setIsCheckingStorage(false);

          const isValid = await verifyGitHubToken(result.githubToken);
          if (!isValid) {
            await handleUnlink('Session expired (401). Please re-authenticate.');
            chrome.action.setBadgeText({ text: '!' });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
          }
        } else {
          setStatusMessage('Account Unlinked');
          setIsCheckingStorage(false);
        }
      }
    );
  }, []);

  const verifyGitHubToken = async (token: string): Promise<boolean> => {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.status !== 401;
    } catch {
      return true;
    }
  };

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

  const handleUnlink = async (customMessage = 'Account Unlinked') => {
    await chrome.storage.local.remove(['isAuthenticated', 'githubUsername', 'githubToken']);
    setIsAuthenticated(false);
    setGithubUsername('');
    setStatusMessage(customMessage);
  };

  const handleRepoChange = (newRepo: string) => {
    setRepoName(newRepo);
    chrome.storage.local.set({ repoName: newRepo });
  };

  if (isCheckingStorage) {
    return <div className="popup-container" />;
  }

  return (
    <div className="popup-container">
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
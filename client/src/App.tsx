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
          // Validate that the token hasn't expired or been revoked (Spec requirement)
          const isValid = await verifyGitHubToken(result.githubToken);
          if (isValid) {
            setIsAuthenticated(true);
            setGithubUsername(result.githubUsername);
            setStatusMessage('Connected to GitHub');
          } else {
            // Token was revoked -> clear auth & show warning badge
            await handleUnlink('Session expired (401). Please re-authenticate.');
            chrome.action.setBadgeText({ text: '!' });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
          }
        } else {
          setStatusMessage('Not connected');
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
          setStatusMessage('Connected to GitHub');
        } else {
          setStatusMessage(`Auth failed: ${response?.error || 'Unknown error'}`);
        }
      }
    );
  };

  // 3. Unlink / Logout handler
  const handleUnlink = async (customMessage = 'Account unlinked') => {
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

  // 5. Context Bridge Test Toast
  const testPageToast = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      setStatusMessage('Cannot run on internal browser pages!');
      return;
    }

    await chrome.scripting.executeScript<string[], void>({
      target: { tabId: tab.id },
      args: [repoName],
      func: (targetRepo) => {
        const toast = document.createElement('div');
        toast.innerText = `🚀 LeetSync Ready! Target Repo: ${targetRepo}`;
        Object.assign(toast.style, {
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          backgroundColor: '#10b981',
          color: '#ffffff',
          padding: '12px 20px',
          borderRadius: '8px',
          fontWeight: 'bold',
          zIndex: '999999',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          fontFamily: 'sans-serif',
        });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3500);
      },
    });
  };

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h2>⚡ LeetSync</h2>
        <span className={`badge ${isAuthenticated ? 'connected' : 'disconnected'}`}>
          {isAuthenticated ? '● Linked' : '○ Unlinked'}
        </span>
      </header>

      {/* 1. GitHub Auth Section */}
      <section className="card">
        {!isAuthenticated ? (
          <button
            className="btn-primary"
            onClick={handleAuthenticate}
            disabled={isLoading}
          >
            {isLoading ? 'Authenticating...' : 'Authenticate with GitHub'}
          </button>
        ) : (
          <div className="account-info">
            <p><strong>Account:</strong> @{githubUsername}</p>
            <p><strong>Linked Repo:</strong> {githubUsername}/{repoName}</p>
            <button
              className="btn-danger"
              onClick={() => handleUnlink()}
            >
              Unlink GitHub Account
            </button>
          </div>
        )}
      </section>

      {/* 2. Target Repository Input */}
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

      {/* 3. Status & Context Bridge Test */}
      <footer className="popup-footer">
        <p className="status-text">Status: {statusMessage}</p>
        <button className="btn-secondary" onClick={testPageToast}>
          Test Toast on Active Page
        </button>
      </footer>
    </div>
  );
}

export default App;
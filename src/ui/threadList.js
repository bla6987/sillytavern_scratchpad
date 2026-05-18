/**
 * Thread List View component for Scratch Pad extension
 */

import { getThreads, getThreadsForCurrentBranch, getCurrentChatLength, createThread, deleteThread, updateThread, saveMetadata } from '../storage.js';
import { getCurrentContextSettings } from '../settings.js';
import { formatTimestamp, truncateText, createButton, showConfirmDialog, showPromptDialog, showToast, Icons } from './components.js';
import { isPinnedMode, togglePinnedMode } from './index.js';

// Dynamic import to avoid circular dependency
let conversationModule = null;
async function getConversationModule() {
    if (!conversationModule) {
        conversationModule = await import('./conversation.js');
    }
    return conversationModule;
}

let threadListContainer = null;
let currentSearchQuery = '';
let searchDebounceTimer = null;
const searchIndexCache = new Map();
const SEARCH_DEBOUNCE_MS = 180;
const MAX_SEARCH_RESULTS = 50;
const SNIPPET_RADIUS = 42;

/**
 * Reset transient thread-list state when closing Scratch Pad or changing chats.
 */
export function resetThreadListState() {
    currentSearchQuery = '';
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
    searchIndexCache.clear();
}

/**
 * Render the thread list view
 * @param {HTMLElement} container Container element
 */
export function renderThreadList(container) {
    threadListContainer = container;

    container.innerHTML = '';
    // Preserve sp-drawer-content class while adding view-specific class
    container.className = 'sp-drawer-content sp-thread-list-view';

    // Header
    const header = document.createElement('div');
    header.className = 'sp-header';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'sp-title-container';

    const titleEl = document.createElement('h2');
    titleEl.className = 'sp-title';
    titleEl.textContent = 'Scratch Pad';
    titleContainer.appendChild(titleEl);

    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'sp-subtitle';
    subtitleEl.textContent = 'Out of Character';
    titleContainer.appendChild(subtitleEl);

    header.appendChild(titleContainer);

    // Pin button
    const pinBtn = createButton({
        icon: Icons.pin,
        className: `sp-header-btn sp-pin-btn ${isPinnedMode() ? 'sp-pinned-active' : ''}`,
        ariaLabel: isPinnedMode() ? 'Unpin drawer' : 'Pin drawer to side',
        onClick: () => {
            const newState = togglePinnedMode();
            pinBtn.classList.toggle('sp-pinned-active', newState);
            pinBtn.setAttribute('aria-label', newState ? 'Unpin drawer' : 'Pin drawer to side');
        }
    });
    header.appendChild(pinBtn);

    const closeBtn = createButton({
        icon: Icons.close,
        className: 'sp-close-btn',
        ariaLabel: 'Close scratch pad',
        onClick: () => closeScratchPadDrawer()
    });
    header.appendChild(closeBtn);
    container.appendChild(header);

    // Action bar
    const actionBar = document.createElement('div');
    actionBar.className = 'sp-action-bar';

    const newThreadBtn = createButton({
        icon: Icons.add,
        text: 'New Thread',
        className: 'sp-new-thread-btn',
        onClick: () => handleNewThread()
    });
    actionBar.appendChild(newThreadBtn);
    container.appendChild(actionBar);

    // Search
    const searchContainer = document.createElement('div');
    searchContainer.className = 'sp-thread-search-container';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'sp-thread-search-input';
    searchInput.placeholder = 'Search threads...';
    searchInput.value = currentSearchQuery;
    searchInput.setAttribute('aria-label', 'Search scratch pad threads');

    const searchMeta = document.createElement('div');
    searchMeta.className = 'sp-thread-search-meta';
    searchMeta.setAttribute('aria-live', 'polite');

    searchInput.addEventListener('input', (e) => {
        const nextQuery = e.target.value;
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            currentSearchQuery = nextQuery;
            renderThreadContent(listContainer, searchMeta, currentSearchQuery);
        }, SEARCH_DEBOUNCE_MS);
    });

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(searchMeta);
    container.appendChild(searchContainer);

    // Thread list
    const listContainer = document.createElement('div');
    listContainer.className = 'sp-thread-list';
    listContainer.id = 'sp-thread-list';
    container.appendChild(listContainer);

    renderThreadContent(listContainer, searchMeta, currentSearchQuery);

    if (currentSearchQuery) {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }

    // Quick input at bottom
    const inputContainer = document.createElement('div');
    inputContainer.className = 'sp-quick-input-container';

    const quickInput = document.createElement('textarea');
    quickInput.className = 'sp-quick-input';
    quickInput.placeholder = 'Ask a question to start a new thread...';
    quickInput.rows = 2;

    const sendBtn = createButton({
        icon: Icons.send,
        text: 'Send',
        className: 'sp-send-btn',
        onClick: () => handleQuickSend(quickInput.value)
    });

    quickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleQuickSend(quickInput.value).catch(err => {
                console.error('[ScratchPad] Quick send error:', err);
            });
        }
    });

    inputContainer.appendChild(quickInput);
    inputContainer.appendChild(sendBtn);
    container.appendChild(inputContainer);
}

/**
 * Render either the default branch-aware thread list or active search results.
 * @param {HTMLElement} listContainer Thread list container
 * @param {HTMLElement} searchMeta Search status element
 * @param {string} query Current search query
 */
function renderThreadContent(listContainer, searchMeta, query = '') {
    listContainer.innerHTML = '';
    const trimmedQuery = query.trim();

    if (trimmedQuery) {
        renderSearchResults(listContainer, searchMeta, trimmedQuery);
        return;
    }

    searchMeta.textContent = '';

    const threads = getThreadsForCurrentBranch();

    // Partition threads by branch relevance
    const currentBranchThreads = [];
    const offBranchThreads = [];
    const emptyThreads = [];

    for (const thread of threads) {
        if (thread.messages.length > 0) {
            currentBranchThreads.push(thread);
        } else if (thread.branchedMessages && thread.branchedMessages.length > 0) {
            offBranchThreads.push(thread);
        } else {
            emptyThreads.push(thread);
        }
    }

    if (currentBranchThreads.length === 0 && offBranchThreads.length === 0 && emptyThreads.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sp-empty-state';
        emptyState.innerHTML = `
            <div class="sp-empty-icon">${Icons.thread}</div>
            <p>No threads yet.</p>
            <p>Start a conversation to create one.</p>
        `;
        listContainer.appendChild(emptyState);
    } else {
        // Main list: threads with messages in current branch, then empty threads
        for (const thread of currentBranchThreads) {
            listContainer.appendChild(createThreadItem(thread));
        }
        for (const thread of emptyThreads) {
            listContainer.appendChild(createThreadItem(thread));
        }

        // Off-branch threads in collapsible section
        if (offBranchThreads.length > 0) {
            const details = document.createElement('details');
            details.className = 'sp-offbranch-threads';

            const summary = document.createElement('summary');
            const count = offBranchThreads.length;
            summary.textContent = `${count} thread${count !== 1 ? 's' : ''} from other branches`;
            details.appendChild(summary);

            const content = document.createElement('div');
            content.className = 'sp-offbranch-threads-content';
            for (const thread of offBranchThreads) {
                content.appendChild(createThreadItem(thread));
            }
            details.appendChild(content);

            listContainer.appendChild(details);
        }
    }
}

/**
 * Render search results across all stored threads for the current chat.
 * @param {HTMLElement} listContainer Thread list container
 * @param {HTMLElement} searchMeta Search status element
 * @param {string} query Search query
 */
function renderSearchResults(listContainer, searchMeta, query) {
    const threads = getThreads();
    const results = searchThreads(threads, query);
    const visibleResults = results.slice(0, MAX_SEARCH_RESULTS);

    searchMeta.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}${results.length > MAX_SEARCH_RESULTS ? `, showing ${MAX_SEARCH_RESULTS}` : ''}`;

    if (visibleResults.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sp-empty-state';
        emptyState.innerHTML = `
            <div class="sp-empty-icon">${Icons.thread}</div>
            <p>No matching threads.</p>
            <p>Try a different word or phrase.</p>
        `;
        listContainer.appendChild(emptyState);
        return;
    }

    for (const result of visibleResults) {
        listContainer.appendChild(createThreadItem(result.thread, {
            query,
            previewText: result.snippet,
            matchType: result.matchType,
            branchLabel: result.branchLabel,
            isSearchResult: true
        }));
    }
}

/**
 * Search all threads by title, active content, and swipe variants.
 * @param {Array} threads Threads to search
 * @param {string} query Search query
 * @returns {Array} Ranked search results
 */
function searchThreads(threads, query) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return [];

    const currentLength = getCurrentChatLength();
    const fuzzyTitleIds = getFuzzyTitleMatchIds(threads, query);
    const results = [];

    for (const thread of threads) {
        const index = getThreadSearchIndex(thread, currentLength);
        const titleIndex = index.title.indexOf(normalizedQuery);
        const contentMatch = findContentMatch(index.entries, normalizedQuery);
        const fuzzyTitleMatch = !contentMatch && titleIndex < 0 && fuzzyTitleIds.has(thread.id);

        if (titleIndex < 0 && !contentMatch && !fuzzyTitleMatch) continue;

        const matchType = titleIndex >= 0 || fuzzyTitleMatch ? 'Title' : 'Message';
        const branchLabel = contentMatch?.branchLabel || index.defaultBranchLabel;
        const snippet = contentMatch
            ? createSnippet(contentMatch.text, normalizedQuery, contentMatch.index)
            : (fuzzyTitleMatch ? 'Fuzzy title match' : 'Thread title match');
        const rank = getSearchRank({ titleIndex, contentMatch, fuzzyTitleMatch, branchLabel });

        results.push({ thread, snippet, matchType, branchLabel, rank });
    }

    return results.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return new Date(b.thread.updatedAt) - new Date(a.thread.updatedAt);
    });
}

/**
 * Build or retrieve cached searchable text for a thread.
 * @param {Object} thread Thread object
 * @param {number|null} currentLength Current chat length
 * @returns {Object} Search index
 */
function getThreadSearchIndex(thread, currentLength) {
    const cacheKey = `${thread.id}:${thread.updatedAt}:${currentLength ?? 'all'}`;
    const cached = searchIndexCache.get(cacheKey);
    if (cached) return cached;

    const entries = [];
    let hasCurrentBranchMessage = false;
    let hasOffBranchMessage = false;

    for (const msg of thread.messages || []) {
        const branchLabel = getMessageBranchLabel(msg, currentLength);
        if (branchLabel === 'Other branch') {
            hasOffBranchMessage = true;
        } else {
            hasCurrentBranchMessage = true;
        }

        for (const text of getMessageSearchTexts(msg)) {
            entries.push({
                text,
                normalized: normalizeSearchText(text),
                branchLabel
            });
        }
    }

    const index = {
        title: normalizeSearchText(thread.name),
        entries,
        defaultBranchLabel: hasCurrentBranchMessage || !hasOffBranchMessage ? 'Current branch' : 'Other branch'
    };

    for (const key of searchIndexCache.keys()) {
        if (key.startsWith(`${thread.id}:`) && key !== cacheKey) {
            searchIndexCache.delete(key);
        }
    }
    searchIndexCache.set(cacheKey, index);

    return index;
}

/**
 * Get searchable text variants for a message, including assistant swipes.
 * @param {Object} message Message object
 * @returns {Array<string>} Searchable text values
 */
function getMessageSearchTexts(message) {
    const texts = [];
    const seen = new Set();

    for (const text of [message?.content, ...(Array.isArray(message?.swipes) ? message.swipes : [])]) {
        if (!text || seen.has(text)) continue;
        seen.add(text);
        texts.push(text);
    }

    return texts;
}

/**
 * Get branch label for a stored message.
 * @param {Object} message Message object
 * @param {number|null} currentLength Current chat length
 * @returns {string} Branch label
 */
function getMessageBranchLabel(message, currentLength) {
    if (currentLength === null || message.chatMessageIndex === undefined || message.chatMessageIndex === null) {
        return 'Current branch';
    }

    return message.chatMessageIndex <= currentLength ? 'Current branch' : 'Other branch';
}

/**
 * Find the first content entry matching the query.
 * @param {Array} entries Search entries
 * @param {string} normalizedQuery Normalized query
 * @returns {Object|null} Match metadata
 */
function findContentMatch(entries, normalizedQuery) {
    let fallbackMatch = null;

    for (const entry of entries) {
        const index = entry.normalized.indexOf(normalizedQuery);
        if (index < 0) continue;

        const match = { ...entry, index };
        if (entry.branchLabel === 'Current branch') return match;
        if (!fallbackMatch) fallbackMatch = match;
    }

    return fallbackMatch;
}

/**
 * Get fuzzy title matches using SillyTavern's Fuse library when available.
 * @param {Array} threads Threads to search
 * @param {string} query Raw query
 * @returns {Set<string>} Matching thread IDs
 */
function getFuzzyTitleMatchIds(threads, query) {
    const { Fuse } = SillyTavern.libs;
    if (!Fuse || threads.length === 0) return new Set();

    const fuse = new Fuse(threads, {
        keys: ['name'],
        threshold: 0.4,
        ignoreLocation: true
    });

    return new Set(fuse.search(query).map(result => result.item.id));
}

/**
 * Rank title/current-branch matches above off-branch body matches.
 * @param {Object} match Match metadata
 * @returns {number} Sort rank
 */
function getSearchRank({ titleIndex, contentMatch, fuzzyTitleMatch, branchLabel }) {
    if (titleIndex === 0) return 0;
    if (titleIndex > 0) return 1;
    if (fuzzyTitleMatch) return 2;
    if (contentMatch && branchLabel === 'Current branch') return 3;
    return 4;
}

/**
 * Create a compact result snippet around a match.
 * @param {string} text Source text
 * @param {string} normalizedQuery Normalized query
 * @param {number} normalizedIndex Match index in normalized text
 * @returns {string} Snippet text
 */
function createSnippet(text, normalizedQuery, normalizedIndex) {
    const start = Math.max(0, normalizedIndex - SNIPPET_RADIUS);
    const end = Math.min(text.length, normalizedIndex + normalizedQuery.length + SNIPPET_RADIUS);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';

    return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

/**
 * Normalize text for case-insensitive searching.
 * @param {string} text Text to normalize
 * @returns {string} Normalized text
 */
function normalizeSearchText(text) {
    return (text || '').toString().toLowerCase();
}

/**
 * Create a thread list item element
 * @param {Object} thread Thread object
 * @param {Object} [options] Rendering options
 * @returns {HTMLElement} Thread item element
 */
function createThreadItem(thread, options = {}) {
    const item = document.createElement('div');
    item.className = 'sp-thread-item';
    if (options.isSearchResult) {
        item.classList.add('sp-thread-search-result');
    }
    item.dataset.threadId = thread.id;

    const hasNoContextMessages = Array.isArray(thread.messages) && thread.messages.some(m => m && m.noContext);
    if (hasNoContextMessages) {
        item.classList.add('sp-thread-item-nocontext');
    }

    // Main clickable area
    const mainContent = document.createElement('div');
    mainContent.className = 'sp-thread-main';
    mainContent.setAttribute('role', 'button');
    mainContent.setAttribute('tabindex', '0');
    mainContent.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            mainContent.click();
        }
    });
    mainContent.addEventListener('click', async () => {
        try {
            const { openThread } = await getConversationModule();
            openThread(thread.id);
            // In fullscreen mobile, hide sidebar and show main
            const fsSidebar = document.querySelector('.sp-fullscreen-sidebar');
            const fsMain = document.querySelector('.sp-fullscreen-main');
            if (fsSidebar && fsMain && window.innerWidth <= 768) {
                fsSidebar.classList.add('sp-fs-hidden');
                fsMain.classList.remove('sp-fs-hidden');
            }
        } catch (err) {
            console.error('[ScratchPad] Error opening thread:', err);
        }
    });

    // Thread name
    const nameRowEl = document.createElement('div');
    nameRowEl.className = 'sp-thread-name-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'sp-thread-name';
    nameEl.textContent = thread.name;
    nameRowEl.appendChild(nameEl);

    // Profile override indicator
    const threadProfile = thread.contextSettings?.connectionProfile;
    if (threadProfile) {
        const profileBadgeEl = document.createElement('span');
        profileBadgeEl.className = 'sp-thread-profile-indicator';
        profileBadgeEl.title = threadProfile;  // Tooltip on hover
        nameRowEl.appendChild(profileBadgeEl);
    }

    if (hasNoContextMessages) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'sp-message-badge sp-message-badge-nocontext';
        badgeEl.textContent = 'No Context';
        nameRowEl.appendChild(badgeEl);
    }

    if (options.isSearchResult) {
        const branchBadgeEl = document.createElement('span');
        branchBadgeEl.className = `sp-thread-branch-badge ${options.branchLabel === 'Other branch' ? 'sp-thread-branch-badge-other' : ''}`;
        branchBadgeEl.textContent = options.branchLabel || 'Current branch';
        nameRowEl.appendChild(branchBadgeEl);
    }

    mainContent.appendChild(nameRowEl);

    // Preview of last message
    const lastMessage = thread.messages?.[thread.messages.length - 1];
    if (options.previewText) {
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview sp-thread-search-snippet';
        previewEl.textContent = truncateText(options.previewText, 110);
        mainContent.appendChild(previewEl);
    } else if (lastMessage) {
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview';
        previewEl.textContent = truncateText(lastMessage.content, 60);
        mainContent.appendChild(previewEl);
    } else if (thread.branchedMessages && thread.branchedMessages.length > 0) {
        // Show preview from last branched message
        const lastBranched = thread.branchedMessages[thread.branchedMessages.length - 1];
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview sp-thread-preview-branched';
        previewEl.textContent = truncateText(lastBranched.content, 60);
        mainContent.appendChild(previewEl);
    } else {
        // Thread has no messages in this branch
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview sp-thread-preview-empty';
        previewEl.textContent = '(no messages in this branch)';
        mainContent.appendChild(previewEl);
    }

    // Timestamp
    const timeEl = document.createElement('div');
    timeEl.className = 'sp-thread-time';
    timeEl.textContent = options.matchType
        ? `${options.matchType} match · ${formatTimestamp(thread.updatedAt)}`
        : formatTimestamp(thread.updatedAt);
    mainContent.appendChild(timeEl);

    item.appendChild(mainContent);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'sp-thread-actions';

    const renameBtn = createButton({
        icon: Icons.edit,
        className: 'sp-action-btn sp-rename-btn',
        ariaLabel: 'Rename thread',
        onClick: (e) => {
            e.stopPropagation();
            handleRenameThread(thread);
        }
    });

    const deleteBtn = createButton({
        icon: Icons.delete,
        className: 'sp-action-btn sp-delete-btn',
        ariaLabel: 'Delete thread',
        onClick: (e) => {
            e.stopPropagation();
            handleDeleteThread(thread);
        }
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(actions);

    // Swipe to delete (touch support)
    let touchStartX = 0;
    let touchEndX = 0;

    item.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    item.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        if (touchStartX - touchEndX > 100) {
            // Swiped left
            item.classList.add('sp-swipe-delete');
        } else if (touchEndX - touchStartX > 50) {
            // Swiped right - cancel
            item.classList.remove('sp-swipe-delete');
        }
    }, { passive: true });

    return item;
}

/**
 * Handle creating a new thread
 */
async function handleNewThread() {
    try {
        const { startNewThread } = await getConversationModule();
        startNewThread();
        // In fullscreen mobile, show main panel
        const fsSidebar = document.querySelector('.sp-fullscreen-sidebar');
        const fsMain = document.querySelector('.sp-fullscreen-main');
        if (fsSidebar && fsMain && window.innerWidth <= 768) {
            fsSidebar.classList.add('sp-fs-hidden');
            fsMain.classList.remove('sp-fs-hidden');
        }
    } catch (err) {
        console.error('[ScratchPad] Error starting new thread:', err);
    }
}

/**
 * Handle quick send from thread list
 * @param {string} message Message to send
 */
async function handleQuickSend(message) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    // Clear input
    const quickInput = document.querySelector('.sp-quick-input');
    if (quickInput) {
        quickInput.value = '';
    }

    // Create new thread with current global context settings
    const contextSettings = getCurrentContextSettings();
    const thread = createThread('New Thread', contextSettings);
    if (!thread) {
        showToast('Failed to create thread', 'error');
        return;
    }

    await saveMetadata();

    // Open the thread and send the message
    try {
        const { openThread } = await getConversationModule();
        openThread(thread.id, trimmedMessage);
        // In fullscreen, ensure main is visible and refresh sidebar
        const fsSidebar = document.querySelector('.sp-fullscreen-sidebar');
        const fsMain = document.querySelector('.sp-fullscreen-main');
        if (fsSidebar && fsMain) {
            fsMain.classList.remove('sp-fs-hidden');
            if (window.innerWidth <= 768) {
                fsSidebar.classList.add('sp-fs-hidden');
            }
            const sidebarContent = fsSidebar.querySelector('.sp-drawer-content');
            if (sidebarContent) {
                renderThreadList(sidebarContent);
            }
        }
    } catch (err) {
        console.error('[ScratchPad] Error opening thread:', err);
    }
}

/**
 * Handle renaming a thread
 * @param {Object} thread Thread object
 */
async function handleRenameThread(thread) {
    const newName = await showPromptDialog('Enter new thread name:', thread.name);

    if (newName && newName.trim() && newName.trim() !== thread.name) {
        updateThread(thread.id, { name: newName.trim() });
        await saveMetadata();
        refreshThreadList();
        showToast('Thread renamed', 'success');
    }
}

/**
 * Handle deleting a thread
 * @param {Object} thread Thread object
 */
async function handleDeleteThread(thread) {
    const confirmed = await showConfirmDialog(
        `Delete thread "${thread.name}"? This cannot be undone.`,
        { confirmText: 'Delete', cancelText: 'Cancel' }
    );

    if (confirmed) {
        deleteThread(thread.id);
        await saveMetadata();
        refreshThreadList();
        showToast('Thread deleted', 'success');
    }
}

/**
 * Refresh the thread list
 */
export function refreshThreadList() {
    if (threadListContainer) {
        renderThreadList(threadListContainer);
    }
}

/**
 * Close the scratch pad drawer
 */
async function closeScratchPadDrawer() {
    const { closeScratchPad } = await import('./index.js');
    closeScratchPad();
}

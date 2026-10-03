const suggestionCache = new Map();

/** Checkouts on this machine, best match for the channel first. */
function suggestRepos(channel) {
  const key = channelKey(channel);
  const cached = suggestionCache.get(key);
  if (cached && Date.now() - cached.at < 30000) return Promise.resolve(cached.repos);
  return ask({ op: 'suggest-repos', channel }).then((res) => {
    const repos = Array.isArray(res.repos) ? res.repos : [];
    suggestionCache.set(key, { at: Date.now(), repos });
    return repos;
  }).catch(() => []);
}

function loadMenuSuggestions(menu, before, channel) {
  suggestRepos(channel).then((repos) => {
    if (menuEl !== menu || repos.length === 0) return;
    for (const repo of repos.slice(0, MENU_SUGGESTIONS)) {
      const pick = menuButton('sq-menu-suggest', () => {
        const target = menuRow;
        closeMenu();
        linkRepo(channel, repo.path, target);
        schedule();
      });
      pick.title = `Link #${channel} to ${repo.display || repo.path}`;
      // The name is the whole label; the menu is too narrow for a path, and
      // the tooltip has it.
      spans(pick, [['sq-glyph', repo.score > 0 ? '★' : '+'], ['', `Link ${repo.name}`]]);
      menu.insertBefore(pick, before);
    }
    schedule();
  });
}

/**
 * Link, then carry straight on: the menu reopens on the message it came
 * from with the prompts in it, so linking is a step on the way to a
 * session rather than a detour away from one. A channel that already has a
 * repo gains another; the one just added is picked, since it is plainly the
 * one wanted next.
 */
function linkRepo(channel, repoPath, row, onError) {
  return ask({ op: 'link-repo', channel, repoPath }).then((res) => {
    if (res.error) {
      const text = res.hint ? `${res.error} — ${res.hint}` : res.error;
      if (onError) onError(text);
      else toast({ title: 'Could not link that repo', sub: text, kind: 'error' });
      return false;
    }
    // The daemon broadcasts the new config too; this just saves waiting for it.
    storeRepos(channel, res.repos || [res.repo || '']);
    if (res.repo) repoPicks.set(channelKey(channel), res.repo);
    const count = reposFor(channel).length;
    toast({
      title: `#${channel} → ${res.repo}`,
      sub: count > 1
        ? `Added. #${channel} has ${count} repos; the menu asks which.`
        : row ? 'Linked. Now pick what to do with this message.' : 'Linked. Hover any message to start a sidequest.',
      burst: true,
    });
    if (row && row.isConnected && channelFor(row) === channel) openMenu(row);
    return true;
  }).catch((err) => {
    if (onError) onError(err.message);
    else toast({ title: 'Could not link that repo', sub: err.message, kind: 'error' });
    return false;
  }).finally(() => schedule());
}

/** Take one repo off a channel, or all of them when `repo` is empty. */
function unlinkRepo(channel, repo, onError) {
  return ask({ op: 'link-repo', channel, repoPath: '', repo }).then((res) => {
    if (res.error) {
      const text = res.hint ? `${res.error} — ${res.hint}` : res.error;
      if (onError) onError(text);
      else toast({ title: 'Could not unlink that repo', sub: text, kind: 'error' });
      return false;
    }
    storeRepos(channel, res.repos || []);
    const left = reposFor(channel);
    toast(left.length > 0
      ? { title: `Unlinked ${repo} from #${channel}`, sub: `Sessions here now start in ${left.join(', ')}.` }
      : { title: `Unlinked #${channel}` });
    return true;
  }).catch((err) => {
    if (onError) onError(err.message);
    else toast({ title: 'Could not unlink that repo', sub: err.message, kind: 'error' });
    return false;
  }).finally(() => schedule());
}

function storeRepos(channel, repos) {
  const key = channelKey(channel);
  const list = repos.filter(Boolean);
  const labels = Object.assign({}, CONFIG.repoLabels);
  if (list.length > 0) {
    labels[key] = list;
    if (!CONFIG.linkedChannels.includes(key)) CONFIG.linkedChannels = CONFIG.linkedChannels.concat(key);
  } else {
    delete labels[key];
    CONFIG.linkedChannels = CONFIG.linkedChannels.filter((c) => c !== key);
  }
  CONFIG.repoLabels = labels;
}

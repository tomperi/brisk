// Shared header identity, loaded on every page so the header is identical
// everywhere: resolve the viewer, show "signed in as …" or a sign-in link, and
// (where the dashboard's presence dot exists) light it up when others are here.
// Exposes the resolved-user promise as `window.briskWhoami` for the dashboard.
window.briskWhoami = (() => {
  const el = (id) => document.getElementById(id);

  // On a public instance, signed-out visitors get a 401 here: show the sign-in
  // link and skip presence (its websocket would be rejected anyway).
  return brisk.me().then(
    (user) => {
      el('who').textContent = user.name === 'Dev' ? user.email : user.name.toLowerCase();
      el('whoami').hidden = false;

      const presence = el('presence');
      if (presence) {
        const lobby = brisk.channel('dashboard');
        lobby.on('presence', (members) => {
          const others = members.length - 1;
          presence.hidden = others < 1;
          if (others >= 1)
            presence.title = `${others} other ${others === 1 ? 'person' : 'people'} here now`;
        });
      }
      return user;
    },
    () => {
      el('signin').hidden = false;
      return null;
    },
  );
})();

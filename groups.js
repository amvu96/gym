/* ============================================================
   GROUP CHALLENGES
   Shared, multi-writer group data — separate from the single-user
   localStorage/Firestore blob the rest of the app uses. Requires sign-in
   (there's no meaningful "offline group"), reuses the same Firebase app
   instance firebase-sync.js already created (via window.GymSync.getDb()/
   getAuth()), and reuses app.js's toast/confirm/sheet primitives (via
   window.GymUI) so it looks and behaves like the rest of the app.

   Data model (Firestore):
   groups/{groupId}
     name, ownerUid, ownerName, inviteCode, createdAt, memberUids:[uid,...]
   groups/{groupId}/members/{uid}
     uid, displayName, photoURL, color, colorIndex, joinedAt
   groups/{groupId}/challenges/{challengeId}
     title, targetLabel, startDate, endDate, createdBy, createdAt, active
   groups/{groupId}/challenges/{challengeId}/completions/{date_uid}
     uid, date, displayName, color, completedAt, reactions:{uid:emoji}
   ============================================================ */
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, runTransaction, serverTimestamp, limit, deleteField
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

(function(){
  'use strict';

  const MAX_MEMBERS = 8;
  // Distinct, colorblind-considerate palette, chosen for contrast against
  // the app's dark panel background.
  const PALETTE = [
    '#39ff9a', '#3ad6ff', '#ff5f6d', '#ffb84d',
    '#c792ff', '#ff7ad9', '#ffe45e', '#7cf7c9'
  ];

  let db = null, auth = null;
  let currentUser = null;
  let myGroups = []; // [{id, ...data}]
  let myGroupsUnsub = null;

  // Detail-view state for whichever group is currently open
  let activeGroupId = null;
  let activeGroup = null;
  let activeMembers = []; // [{uid, displayName, color, ...}]
  let activeChallenges = []; // all currently-active (not-yet-ended) challenges for this group
  let selectedCalendarChallengeId = null; // which active challenge the calendar below is showing
  let challengeCompletions = {}; // challengeId -> {byDate:{date:[{uid,displayName,color,date}]}, seenKeys, notified, unsub}
  let membersUnsub = null;
  let challengeUnsub = null;
  let calCursor = new Date();
  let selectedChallengeFreq = 'daily'; // working selection in the "New challenge" sheet
  let activityFeedItems = []; // merged, cached feed for the currently-open group

  /* ---------------- small local date helpers (kept independent of app.js) ---------------- */
  function fmtISO(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function todayISO(){ return fmtISO(new Date()); }
  function parseISO(iso){ const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); }

  function ui(){ return window.GymUI || {}; }
  function toast(msg){ if(ui().toast) ui().toast(msg); else console.log(msg); }

  /* ---------------- init / auth wiring ---------------- */
  function init(){
    if(!window.GymSync || !window.GymSync.isConfigured()){
      // Cloud sync not configured — groups view will show a static message.
      return;
    }
    db = window.GymSync.getDb();
    auth = window.GymSync.getAuth();
    window.GymSync.onAuthChange((user)=>{
      currentUser = user;
      teardownMyGroupsListener();
      if(user){
        listenToMyGroups();
      } else {
        myGroups = [];
        teardownAllHomeChallengeListeners();
        notifyHomeRefresh();
        if(document.getElementById('view-groups').classList.contains('active')) renderRoot();
      }
      // If the invite-landing panel is open (e.g. they just tapped
      // "Sign in with Google" from it), refresh it so the Accept button
      // appears now that we know who they are — signing in and accepting
      // are two distinct, explicit steps, not one auto-join.
      if(pendingInviteGroup) renderInvitePanel();
    });

    // Deep-link join: #join=CODE
    if(location.hash.startsWith('#join=')){
      const code = decodeURIComponent(location.hash.slice(6));
      history.replaceState(null, '', location.pathname + location.search);
      pendingJoinCode = code;
    }

    bindStaticUI();

    // A join link can land while the app boots straight to Home — jump to
    // the Groups tab ourselves instead of leaving the code stranded until
    // the person happens to tap the tab manually.
    if(pendingJoinCode && ui().showView){
      ui().showView('groups');
    }
  }

  let pendingJoinCode = null;
  let pendingInviteGroup = null; // {id, name, ownerUid, memberUids, inviteCode} once looked up

  function onShow(){
    // Called by app.js's showView('groups')
    if(pendingJoinCode){
      const code = pendingJoinCode; pendingJoinCode = null;
      handleJoinDeepLink(code);
      return;
    }
    if(pendingInviteGroup){
      renderInvitePanel();
      return;
    }
    if(activeGroupId){
      renderDetail();
    } else {
      renderRoot();
    }
  }

  // Re-render the currently open group's detail panel (used when returning
  // to the Groups tab without a pending join code, e.g. Home → Groups →
  // back). Listeners already keep the data fresh; this just re-shows the
  // right panel and repaints from state already in memory.
  function renderDetail(){
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = '';
    document.getElementById('groupDetailName').textContent = activeGroup ? activeGroup.name : '—';
    renderMembersRow();
    renderChallengesList();
    renderCalendarChallengeSelector();
    renderGroupCalendar();
  }

  // Looks the group up by its invite code (allowed unauthenticated — see
  // firestore.rules) and shows the invite-landing panel rather than joining
  // immediately, so the person always sees what they're accepting first.
  async function handleJoinDeepLink(code){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); renderRoot(); return; }
    try{
      const q = query(collection(db, 'groups'), where('inviteCode', '==', code.toUpperCase()), limit(1));
      const snap = await getDocs(q);
      if(snap.empty){ toast('That invite link is invalid or expired'); renderRoot(); return; }
      const gDoc = snap.docs[0];
      pendingInviteGroup = {id: gDoc.id, ...gDoc.data()};
      renderInvitePanel();
    }catch(e){
      console.error(e);
      toast('Could not load that invite');
      renderRoot();
    }
  }

  function renderInvitePanel(){
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = '';
    document.getElementById('inviteGroupName').textContent = pendingInviteGroup.name;

    const signInBtn = document.getElementById('btnInviteSignIn');
    const acceptBtn = document.getElementById('btnInviteAccept');
    const statusEl = document.getElementById('inviteStatusText');
    signInBtn.style.display = 'none';
    acceptBtn.style.display = 'none';
    statusEl.style.display = 'none';
    statusEl.textContent = '';

    const memberUids = pendingInviteGroup.memberUids || [];
    const alreadyMember = !!(currentUser && memberUids.includes(currentUser.uid));
    const isFull = memberUids.length >= MAX_MEMBERS;

    if(!currentUser){
      signInBtn.style.display = '';
    } else if(alreadyMember){
      statusEl.textContent = "You're already in that group.";
      statusEl.style.display = '';
      acceptBtn.textContent = 'Open group';
      acceptBtn.style.display = '';
    } else if(isFull){
      statusEl.textContent = 'This group is full (8/8 members).';
      statusEl.style.display = '';
    } else {
      acceptBtn.textContent = 'Accept';
      acceptBtn.style.display = '';
    }
  }

  function clearPendingInvite(){
    pendingInviteGroup = null;
    document.getElementById('groupsPanelInvite').style.display = 'none';
  }

  async function onInviteSignIn(){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); return; }
    try{
      await window.GymSync.signIn();
    }catch(e){ /* handled inside signIn() itself */ }
    // onAuthStateChanged can land a beat after the popup promise resolves —
    // poll briefly rather than assuming it's already landed.
    for(let i=0; i<20 && !currentUser; i++){
      await new Promise(r=>setTimeout(r, 100));
      currentUser = window.GymSync.getCurrentUser();
    }
    if(pendingInviteGroup) renderInvitePanel();
  }

  async function onInviteAccept(){
    if(!pendingInviteGroup || !currentUser) return;
    const memberUids = pendingInviteGroup.memberUids || [];
    if(memberUids.includes(currentUser.uid)){
      const id = pendingInviteGroup.id;
      clearPendingInvite();
      openGroup(id);
      return;
    }
    const ok = await joinGroupById(pendingInviteGroup.id);
    if(ok){
      const id = pendingInviteGroup.id;
      clearPendingInvite();
      toast('Joined group');
      openGroup(id);
    }
  }

  function requireSignedIn(msg){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); return false; }
    if(!currentUser){
      toast(msg || 'Sign in to continue');
      if(window.GymSync) window.GymSync.signIn();
      return false;
    }
    return true;
  }

  /* ---------------- my groups list ---------------- */
  function teardownMyGroupsListener(){
    if(myGroupsUnsub){ myGroupsUnsub(); myGroupsUnsub = null; }
  }

  function listenToMyGroups(){
    const q = query(collection(db, 'groups'), where('memberUids', 'array-contains', currentUser.uid));
    myGroupsUnsub = onSnapshot(q, (snap)=>{
      myGroups = snap.docs.map(d=>({id:d.id, ...d.data()}));
      if(document.getElementById('view-groups').classList.contains('active') && !activeGroupId){
        renderRoot();
      }
      syncHomeChallengeListeners();
    }, (err)=>{ console.error('groups listen failed', err); });
  }

  /* ---------------- home-screen "today" challenge cards ----------------
     Tracked independently of whichever group is open in the Groups tab —
     the home carousel needs every group's active-and-in-range challenge
     plus this user's own "done today" status, live, regardless of which
     screen they're on. Each group gets a cheap challenge listener plus,
     only while it has a live in-range challenge, a single-document listener
     on today's own completion doc (not the whole completions collection). */
  let homeChallengeState = {}; // groupId -> {groupName, challengeUnsub, challenges: {challengeId: {challenge, doneToday, completionUnsub}}}

  function syncHomeChallengeListeners(){
    const currentIds = new Set(myGroups.map(g=>g.id));
    Object.keys(homeChallengeState).forEach(gid=>{
      if(!currentIds.has(gid)){
        teardownHomeChallengeEntry(gid);
        delete homeChallengeState[gid];
      }
    });
    myGroups.forEach(g=>{
      if(!homeChallengeState[g.id]){
        homeChallengeState[g.id] = {groupName:g.name, challengeUnsub:null, challenges:{}};
        attachHomeChallengeListener(g.id);
      } else {
        homeChallengeState[g.id].groupName = g.name;
      }
    });
    notifyHomeRefresh();
  }

  function teardownHomeChallengeEntry(groupId){
    const entry = homeChallengeState[groupId];
    if(!entry) return;
    if(entry.challengeUnsub) entry.challengeUnsub();
    Object.values(entry.challenges).forEach(c=>{ if(c.completionUnsub) c.completionUnsub(); });
  }

  // Tracks every active, in-range challenge for a group (not just one) —
  // each gets its own single-document listener on today's completion doc
  // (cheap: one doc, not the whole collection, since Home only needs
  // "done today", unlike the group-detail cards which also need period
  // totals for weekly/monthly challenges).
  function attachHomeChallengeListener(groupId){
    const q = query(collection(db, 'groups', groupId, 'challenges'), where('active','==',true));
    const unsub = onSnapshot(q, (snap)=>{
      const entry = homeChallengeState[groupId];
      if(!entry) return; // group was left/torn down mid-flight

      const today = todayISO();
      const newChallenges = snap.docs
        .map(d=>({id:d.id, ...d.data()}))
        .filter(ch=>today >= ch.startDate && today <= ch.endDate);
      const newIds = new Set(newChallenges.map(c=>c.id));

      // Drop tracking (and its completion listener) for anything no longer
      // active/in-range.
      Object.keys(entry.challenges).forEach(cid=>{
        if(!newIds.has(cid)){
          if(entry.challenges[cid].completionUnsub) entry.challenges[cid].completionUnsub();
          delete entry.challenges[cid];
        }
      });

      newChallenges.forEach(ch=>{
        if(entry.challenges[ch.id]){
          entry.challenges[ch.id].challenge = ch; // refresh in case title/target edited later
          return;
        }
        const compRef = doc(db, 'groups', groupId, 'challenges', ch.id, 'completions', `${today}_${currentUser.uid}`);
        entry.challenges[ch.id] = {
          challenge: ch, doneToday: false,
          completionUnsub: onSnapshot(compRef, (compSnap)=>{
            if(!entry.challenges[ch.id]) return;
            entry.challenges[ch.id].doneToday = compSnap.exists();
            notifyHomeRefresh();
          }, (err)=>console.error('home completion listen failed', err))
        };
      });

      notifyHomeRefresh();
    }, (err)=>console.error('home challenge listen failed', err));
    homeChallengeState[groupId].challengeUnsub = unsub;
  }

  function teardownAllHomeChallengeListeners(){
    Object.keys(homeChallengeState).forEach(teardownHomeChallengeEntry);
    homeChallengeState = {};
  }

  function notifyHomeRefresh(){
    if(window.GymUI && window.GymUI.refreshHomeChallengesIfVisible) window.GymUI.refreshHomeChallengesIfVisible();
  }

  // Called by app.js's home-screen carousel to get this user's active,
  // in-range group challenges — now one card per (group, challenge) pair,
  // since a group can have several running at once. Pure data — app.js owns
  // the actual markup so group cards render identically to routine cards.
  function getHomeChallengeCards(){
    const cards = [];
    Object.entries(homeChallengeState).forEach(([groupId,e])=>{
      Object.values(e.challenges).forEach(c=>{
        cards.push({
          groupId,
          groupName: e.groupName,
          challengeId: c.challenge.id,
          title: c.challenge.title,
          targetLabel: c.challenge.targetLabel,
          doneToday: !!c.doneToday
        });
      });
    });
    return cards;
  }

  // Called when a home-screen group-challenge card is tapped — switches to
  // the Groups tab and opens that specific group.
  function openGroupFromHome(groupId){
    if(window.GymUI && window.GymUI.showView) window.GymUI.showView('groups');
    openGroup(groupId);
  }

  function renderRoot(){
    document.getElementById('groupsPanelDetail').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelList').style.display = '';

    const container = document.getElementById('groupsListContainer');
    if(!db){
      container.innerHTML = `<div class="empty-state">
        <p>Group challenges need cloud sync configured for this app.</p>
      </div>`;
      return;
    }
    if(!currentUser){
      container.innerHTML = `<div class="empty-state">
        <p>Sign in to create or join a group challenge with friends.</p>
      </div>`;
      return;
    }
    if(myGroups.length===0){
      container.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><circle cx="17" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>
        <p>No groups yet. Create one or join with an invite link.</p>
      </div>`;
      return;
    }
    container.innerHTML = myGroups.map(g=>{
      const count = (g.memberUids||[]).length;
      return `<div class="card group-list-item" data-group="${g.id}" style="cursor:pointer; margin-bottom:10px;">
        <div class="row">
          <div style="min-width:0;">
            <div class="settings-row-label">${escapeHtml(g.name)}</div>
            <div class="settings-row-sub">${count}/${MAX_MEMBERS} members</div>
          </div>
        </div>
      </div>`;
    }).join('');
    container.querySelectorAll('[data-group]').forEach(el=>{
      el.addEventListener('click', ()=>openGroup(el.dataset.group));
    });
  }

  function bindStaticUI(){
    document.getElementById('btnNewGroup').addEventListener('click', ()=>{
      if(!requireSignedIn()) return;
      document.getElementById('newGroupNameInput').value = '';
      ui().openSheet('sheetCreateGroup');
    });
    document.getElementById('btnConfirmCreateGroup').addEventListener('click', createGroup);

    document.getElementById('btnJoinGroup').addEventListener('click', ()=>{
      if(!requireSignedIn()) return;
      document.getElementById('joinGroupCodeInput').value = '';
      ui().openSheet('sheetJoinGroup');
    });
    document.getElementById('btnConfirmJoinGroup').addEventListener('click', ()=>{
      const code = document.getElementById('joinGroupCodeInput').value.trim();
      if(!code){ toast('Enter an invite code'); return; }
      joinByCode(code);
    });

    document.getElementById('btnBackToGroups').addEventListener('click', closeGroup);
    document.getElementById('btnInviteMembers').addEventListener('click', showInviteSheet);
    document.getElementById('btnNtfySettings').addEventListener('click', showNtfySettingsSheet);
    document.getElementById('btnLeaveGroup').addEventListener('click', leaveActiveGroup);

    document.getElementById('btnInviteSignIn').addEventListener('click', onInviteSignIn);
    document.getElementById('btnInviteAccept').addEventListener('click', onInviteAccept);
    document.getElementById('btnInviteCancel').addEventListener('click', ()=>{
      clearPendingInvite();
      renderRoot();
    });

    document.getElementById('btnNewChallenge').addEventListener('click', ()=>{
      document.getElementById('challengeTitleInput').value = '';
      document.getElementById('challengeTargetInput').value = '';
      document.getElementById('challengeFreqCountInput').value = 3;
      selectedChallengeFreq = 'daily';
      document.querySelectorAll('.challenge-freq-chip').forEach(c=>c.classList.toggle('selected', c.dataset.freq==='daily'));
      document.getElementById('challengeFreqCountField').style.display = 'none';
      const t = new Date();
      document.getElementById('challengeStartInput').value = fmtISO(t);
      const end = new Date(t); end.setDate(end.getDate()+29);
      document.getElementById('challengeEndInput').value = fmtISO(end);
      ui().openSheet('sheetNewChallenge');
    });
    document.getElementById('btnConfirmNewChallenge').addEventListener('click', createChallenge);
    document.querySelectorAll('.challenge-freq-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        selectedChallengeFreq = chip.dataset.freq;
        document.querySelectorAll('.challenge-freq-chip').forEach(c=>c.classList.toggle('selected', c===chip));
        const countField = document.getElementById('challengeFreqCountField');
        const countLabel = document.getElementById('challengeFreqCountLabel');
        if(selectedChallengeFreq==='daily'){
          countField.style.display = 'none';
        } else {
          countField.style.display = '';
          countLabel.textContent = selectedChallengeFreq==='weekly' ? 'Times per week' : 'Times per month';
        }
      });
    });

    document.getElementById('btnChallengeHistory').addEventListener('click', showChallengeHistorySheet);
    document.getElementById('btnActivityFeed').addEventListener('click', showActivityFeedSheet);

    document.getElementById('calGroupPrevMonth').addEventListener('click', ()=>{
      calCursor.setMonth(calCursor.getMonth()-1); renderGroupCalendar();
    });
    document.getElementById('calGroupNextMonth').addEventListener('click', ()=>{
      calCursor.setMonth(calCursor.getMonth()+1); renderGroupCalendar();
    });
  }

  /* ---------------- create / join ---------------- */
  function randomCode(len=6){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let out = '';
    for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
    return out;
  }

  // Deterministic-prefix, random-suffix ntfy topic, generated once per group
  // at creation and never editable afterward — e.g.
  // "gymnullvaulteu-morning-crew-a1b2c3". The prefix identifies it as
  // belonging to this app (so it doesn't collide with unrelated public
  // topics on ntfy.sh), the slug keeps it human-recognizable, and the
  // random suffix keeps it unguessable enough to act as ntfy's de facto
  // access gate (ntfy topics have no real auth by default).
  function slugify(s){
    return String(s||'')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'group';
  }
  function randomNtfyTopic(groupName){
    const suffix = Array.from({length:8}, ()=>'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('');
    return `gymnullvaulteu-${slugify(groupName)}-${suffix}`;
  }

  async function createGroup(){
    const name = document.getElementById('newGroupNameInput').value.trim();
    if(!name){ toast('Give the group a name'); return; }
    if(!requireSignedIn()) return;
    try{
      const inviteCode = randomCode();
      const groupRef = await addDoc(collection(db, 'groups'), {
        name,
        ownerUid: currentUser.uid,
        ownerName: currentUser.name || 'Owner',
        inviteCode,
        ntfyTopic: randomNtfyTopic(name),
        createdAt: Date.now(),
        memberUids: [currentUser.uid]
      });
      await setDoc(doc(db, 'groups', groupRef.id, 'members', currentUser.uid), {
        uid: currentUser.uid,
        displayName: currentUser.name || 'Member',
        photoURL: currentUser.photo || '',
        color: PALETTE[0],
        colorIndex: 0,
        joinedAt: Date.now()
      });
      ui().closeSheet('sheetCreateGroup');
      toast('Group created');
      openGroup(groupRef.id);
    }catch(e){
      console.error(e);
      toast('Could not create group: ' + (e.message||e.code||''));
    }
  }

  async function joinByCode(code){
    if(!requireSignedIn()) return;
    try{
      const q = query(collection(db, 'groups'), where('inviteCode', '==', code.toUpperCase()), limit(1));
      const snap = await getDocs(q);
      if(snap.empty){ toast('No group found with that code'); return; }
      const groupId = snap.docs[0].id;

      const memberRef = doc(db, 'groups', groupId, 'members', currentUser.uid);
      const existing = await getDoc(memberRef);
      if(existing.exists()){
        ui().closeSheet('sheetJoinGroup');
        openGroup(groupId);
        return;
      }

      const ok = await joinGroupById(groupId);
      if(ok){
        ui().closeSheet('sheetJoinGroup');
        toast('Joined group');
        openGroup(groupId);
      }
    }catch(e){
      console.error(e);
      toast(e.message || 'Could not join group');
    }
  }

  // Shared join transaction, used both by the code-entry sheet and the
  // invite-landing page's Accept button. Atomically checks capacity and
  // claims the next free color, so two people accepting at the same moment
  // can't both grab the same color or push the group past MAX_MEMBERS.
  // Returns true on success, false (after toasting) on failure.
  async function joinGroupById(groupId){
    let joined = false, groupName = null, groupTopic = null;
    try{
      await runTransaction(db, async (tx)=>{
        const gRef = doc(db, 'groups', groupId);
        const gSnap = await tx.get(gRef);
        if(!gSnap.exists()) throw new Error('Group no longer exists');
        const data = gSnap.data();
        groupName = data.name;
        groupTopic = data.ntfyTopic;
        const memberUids = data.memberUids || [];
        if(memberUids.includes(currentUser.uid)) return; // already a member
        if(memberUids.length >= MAX_MEMBERS) throw new Error('This group is full (8/8 members)');

        // We can't read the whole members subcollection inside a transaction
        // against an arbitrary-length list cheaply, so colorIndex is derived
        // from position in memberUids, which we already have transactionally.
        const colorIndex = memberUids.length % PALETTE.length;

        tx.update(gRef, { memberUids: [...memberUids, currentUser.uid] });
        tx.set(doc(db, 'groups', groupId, 'members', currentUser.uid), {
          uid: currentUser.uid,
          displayName: currentUser.name || 'Member',
          photoURL: currentUser.photo || '',
          color: PALETTE[colorIndex],
          colorIndex,
          joinedAt: Date.now()
        });
        joined = true;
      });
      if(joined && groupTopic){
        publishNtfy(groupTopic, {
          title: groupName,
          message: `${firstName(currentUser.name)} joined the group`,
          tags: ['wave']
        });
      }
      return true;
    }catch(e){
      console.error(e);
      toast(e.message || 'Could not join group');
      return false;
    }
  }

  async function leaveActiveGroup(){
    if(!activeGroupId) return;
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'Leave group?', message:'You\'ll stop seeing this group\'s challenge and calendar.', confirmLabel:'Leave', danger:true
    }) : confirm('Leave this group?');
    if(!ok) return;
    try{
      const gRef = doc(db, 'groups', activeGroupId);
      const gSnap = await getDoc(gRef);
      if(gSnap.exists()){
        const memberUids = (gSnap.data().memberUids||[]).filter(u=>u!==currentUser.uid);
        await updateDoc(gRef, { memberUids });
      }
      await deleteDoc(doc(db, 'groups', activeGroupId, 'members', currentUser.uid));
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} left the group`,
          tags: ['wave']
        });
      }
      toast('Left group');
      closeGroup();
    }catch(e){
      console.error(e);
      toast('Could not leave group');
    }
  }

  /* ---------------- invite sheet (link + QR) ---------------- */
  function showInviteSheet(){
    if(!activeGroup) return;
    const link = `${location.origin}${location.pathname}#join=${activeGroup.inviteCode}`;
    document.getElementById('inviteLinkText').textContent = link;
    document.getElementById('inviteCodeText').textContent = activeGroup.inviteCode;
    ui().openSheet('sheetInvite');
    renderQr(link);

    document.getElementById('btnCopyInviteLink').onclick = async ()=>{
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch(e){ toast('Could not copy — long-press to copy manually'); }
    };
    document.getElementById('btnShareInviteLink').onclick = async ()=>{
      if(navigator.share){
        try{ await navigator.share({title:`Join ${activeGroup.name}`, url:link}); }
        catch(e){ /* user cancelled share sheet — no action needed */ }
      } else {
        try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
        catch(e){ toast(link); }
      }
    };
  }

  function renderQr(text, elId='inviteQrCanvas'){
    const el = document.getElementById(elId);
    if(!el) return;
    el.innerHTML = '';
    if(window.QRCode){
      new window.QRCode(el, { text, width:180, height:180, colorDark:'#0a0e0f', colorLight:'#d7e5e2' });
    } else {
      el.innerHTML = '<p class="text-sm text-muted">QR code unavailable offline — share the link instead.</p>';
    }
  }

  /* ---------------- ntfy.sh push notifications ----------------
     Fully client-side, no backend of ours needed. Each group gets one
     fixed topic, generated once at creation time (see randomNtfyTopic())
     and stored on the group doc — not owner-editable, no server/token
     fields. Whichever member checks in POSTs a message straight to
     https://ntfy.sh/<topic>; anyone subscribed (via the ntfy app, or just
     ntfy.sh in a browser with background notifications enabled — no app
     install required either way) gets a real push, even with this app
     fully closed. That's the one thing the in-app Firestore-listener
     notifications above can't do. */
  function ntfySubscribeLink(topic){
    return `https://ntfy.sh/${encodeURIComponent(topic)}`;
  }

  async function publishNtfy(topic, {title, message, tags, priority=4}){
    if(!topic) return;
    try{
      await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ topic, title, message, tags: tags||[], priority })
      });
    }catch(e){
      // Never block/interrupt the check-in flow over a notification
      // delivery failure — the completion itself already saved.
      console.error('ntfy publish failed', e);
    }
  }

  function showNtfySettingsSheet(){
    if(!activeGroup) return;
    ui().openSheet('sheetNtfySettings');
    renderNtfySettingsSheet();
  }

  function renderNtfySettingsSheet(){
    const isOwner = currentUser && activeGroup && activeGroup.ownerUid === currentUser.uid;
    const content = document.getElementById('ntfySettingsContent');
    const topic = activeGroup ? activeGroup.ntfyTopic : null;
    const link = topic ? ntfySubscribeLink(topic) : null;
    // The ntfy Android app registers the ntfy:// scheme and, per ntfy's own
    // docs, ntfy://<host>/<topic> opens straight to that topic's detail
    // view and subscribes automatically if not already subscribed — no
    // typing the topic name in by hand. Shown unconditionally rather than
    // gated on a user-agent sniff — that check is unreliable inside a TWA
    // wrapper anyway. Elsewhere it just won't resolve to anything, same as
    // tapping any link for an app that isn't installed.
    const androidAppLink = topic ? `ntfy://ntfy.sh/${encodeURIComponent(topic)}?display=${encodeURIComponent(activeGroup.name)}` : null;

    if(!topic){
      // Every group created going forward gets a topic automatically; this
      // only shows for groups created before this feature existed.
      content.innerHTML = `<p class="text-sm text-muted">Push notifications aren't available for this group — it was created before this feature existed.</p>`;
      return;
    }

    content.innerHTML = `
      <p class="text-sm text-muted mb-16">Get a real push notification — even with this app closed — whenever a teammate completes today's challenge. No app install required: open this group's ntfy page and tap <b>Subscribe</b>, then enable <b>background notifications</b> right there in the browser. (The <a href="https://ntfy.sh" target="_blank" rel="noopener" style="color:var(--accent);">ntfy app</a> works too, if you'd rather use it.)</p>
      <div class="invite-qr-wrap"><div id="ntfySubscribeQr"></div></div>
      <div class="invite-link-box">${escapeHtml(link)}</div>
      <button class="btn btn-primary btn-block mb-8" id="btnOpenNtfyAndroidApp">Open in ntfy Android app</button>
      <button class="btn btn-secondary btn-block mb-8" id="btnOpenNtfyLink">Open ntfy.sh in a new tab</button>
      <button class="btn btn-secondary btn-block" id="btnCopyNtfyLink">Copy link</button>
      ${isOwner ? `<button class="btn btn-secondary btn-block mt-8" id="btnTestNtfyConfig">Send test notification</button>` : ''}
    `;
    renderQr(link, 'ntfySubscribeQr');
    document.getElementById('btnOpenNtfyAndroidApp').addEventListener('click', ()=>{
      // A bare location change (not window.open) is what actually lets
      // Android's intent-resolution kick in for a custom scheme like this.
      window.location.href = androidAppLink;
    });
    document.getElementById('btnOpenNtfyLink').addEventListener('click', ()=>{
      window.open(link, '_blank', 'noopener');
    });
    document.getElementById('btnCopyNtfyLink').addEventListener('click', async ()=>{
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch(e){ toast('Could not copy — long-press to copy manually'); }
    });
    if(isOwner){
      document.getElementById('btnTestNtfyConfig').addEventListener('click', async ()=>{
        await publishNtfy(topic, {
          title: activeGroup.name,
          message: 'Test notification from Gym Tracker 👋',
          tags: ['bell']
        });
        toast('Test sent');
      });
    }
  }

  /* ---------------- group detail ---------------- */
  async function openGroup(groupId){
    activeGroupId = groupId;
    calCursor = new Date();
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = '';
    document.getElementById('groupDetailName').textContent = 'Loading…';
    document.getElementById('groupMembersRow').innerHTML = '';
    document.getElementById('groupChallengesList').innerHTML = '';
    document.getElementById('calGroupGrid').innerHTML = '';

    const gSnap = await getDoc(doc(db, 'groups', groupId));
    if(!gSnap.exists()){ toast('Group not found'); closeGroup(); return; }
    activeGroup = {id:groupId, ...gSnap.data()};
    document.getElementById('groupDetailName').textContent = activeGroup.name;

    teardownDetailListeners();

    membersUnsub = onSnapshot(collection(db, 'groups', groupId, 'members'), (snap)=>{
      activeMembers = snap.docs.map(d=>d.data()).sort((a,b)=>a.colorIndex-b.colorIndex);
      renderMembersRow();
      renderGroupCalendar(); // legend depends on members
      healOwnMemberDoc();
    });

    listenToActiveChallenges();
  }

  function teardownDetailListeners(){
    if(membersUnsub){ membersUnsub(); membersUnsub = null; }
    if(challengeUnsub){ challengeUnsub(); challengeUnsub = null; }
    Object.values(challengeCompletions).forEach(entry=>{ if(entry.unsub) entry.unsub(); });
    challengeCompletions = {};
  }

  function closeGroup(){
    teardownDetailListeners();
    activeGroupId = null; activeGroup = null; activeMembers = []; activeChallenges = [];
    selectedCalendarChallengeId = null;
    activityFeedItems = [];
    renderRoot();
  }

  function renderMembersRow(){
    const row = document.getElementById('groupMembersRow');
    row.innerHTML = activeMembers.map(m=>`
      <div class="group-member-chip" title="${escapeHtml(m.displayName)}">
        <span class="group-color-dot" style="background:${m.color}"></span>
        ${escapeHtml(firstName(m.displayName))}${isOwnerUid(m.uid) ? ' <span class="group-crown" title="Group owner">👑</span>' : ''}
      </div>
    `).join('') + (activeGroup && currentUser && activeGroup.ownerUid===currentUser.uid ? `<div class="group-member-chip group-member-chip-muted">${activeMembers.length}/${MAX_MEMBERS}</div>` : '');
    const leaveBtn = document.getElementById('btnLeaveGroup');
    leaveBtn.style.display = activeMembers.length ? '' : 'none';
  }

  function isOwnerUid(uid){
    return !!(activeGroup && activeGroup.ownerUid === uid);
  }

  function firstName(name){ return (name||'Member').split(' ')[0]; }

  // Repairs this user's own member doc if the name/photo it holds is stale
  // (e.g. saved before the auth-name bug fix, or the person renamed their
  // Google account since joining). Only ever touches the caller's own doc —
  // matches the Firestore rule that a member can update only themselves.
  async function healOwnMemberDoc(){
    if(!currentUser || !activeGroupId) return;
    const mine = activeMembers.find(m=>m.uid===currentUser.uid);
    if(!mine) return;
    const wantName = currentUser.name || 'Member';
    const wantPhoto = currentUser.photo || '';
    if(mine.displayName === wantName && (mine.photoURL||'') === wantPhoto) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId, 'members', currentUser.uid), {
        displayName: wantName, photoURL: wantPhoto
      });
    }catch(e){ console.error('member doc heal failed', e); }
  }

  function listenToActiveChallenges(){
    const q = query(collection(db, 'groups', activeGroupId, 'challenges'), where('active', '==', true));
    challengeUnsub = onSnapshot(q, (snap)=>{
      const newList = snap.docs.map(d=>({id:d.id, ...d.data()})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
      const newIds = new Set(newList.map(c=>c.id));

      // Tear down completions listeners for challenges that dropped out of
      // the active set (owner ended them) so we don't leak listeners.
      Object.keys(challengeCompletions).forEach(cid=>{
        if(!newIds.has(cid)){
          if(challengeCompletions[cid].unsub) challengeCompletions[cid].unsub();
          delete challengeCompletions[cid];
        }
      });

      activeChallenges = newList;
      newList.forEach(ch=>{
        if(!challengeCompletions[ch.id]) attachChallengeCompletionsListener(ch.id);
      });

      // Keep the calendar's selected challenge pointing at something real —
      // default to the newest active challenge the first time, or if the
      // one that was selected just got ended.
      if(!selectedCalendarChallengeId || !newIds.has(selectedCalendarChallengeId)){
        selectedCalendarChallengeId = newList.length ? newList[0].id : null;
      }

      renderChallengesList();
      renderCalendarChallengeSelector();
      renderGroupCalendar();
    }, (err)=>console.error('challenges listen failed', err));
  }

  // One live listener per active challenge, on its full completions
  // collection (not just "today") — needed to compute weekly/monthly
  // period progress (e.g. "2/3 this week"), not just a single day's status.
  // Collections here are small (one group, a handful of members, one
  // challenge's lifetime) so this is cheap even listened to in full.
  function attachChallengeCompletionsListener(challengeId){
    challengeCompletions[challengeId] = {byDate:{}, seenKeys:new Set(), notified:false, unsub:null};
    const ref = collection(db, 'groups', activeGroupId, 'challenges', challengeId, 'completions');
    challengeCompletions[challengeId].unsub = onSnapshot(ref, (snap)=>{
      const entry = challengeCompletions[challengeId];
      if(!entry) return; // challenge was ended/torn down mid-flight

      const byDate = {};
      const currentKeys = new Set();
      snap.forEach(d=>{
        const c = d.data();
        currentKeys.add(d.id);
        (byDate[c.date] = byDate[c.date] || []).push(c);
      });
      entry.byDate = byDate;

      // Notify (foreground toast + Notification) about any check-in that's
      // new since the last snapshot and isn't the current user's own —
      // skipped on the very first snapshot after attaching so opening the
      // group doesn't fire a backlog of "notifications" for history.
      if(entry.notified){
        currentKeys.forEach(key=>{
          if(entry.seenKeys.has(key)) return;
          const cdoc = snap.docs.find(d=>d.id===key);
          if(!cdoc) return;
          const c = cdoc.data();
          if(c.uid !== currentUser.uid) notifyTeammateCompletion(c);
        });
      }
      entry.seenKeys = currentKeys;
      entry.notified = true;

      renderChallengesList();
      if(challengeId===selectedCalendarChallengeId) renderGroupCalendar();
      syncActivityFeedFromActiveChallenges();
    }, (err)=>console.error('completions listen failed', err));
  }

  // Computes this user's progress for a challenge given its frequency —
  // "done today" for daily, "N/target this week|month" for weekly/monthly,
  // counting distinct completed dates within the current period.
  function computeChallengeProgress(ch, byDate){
    const today = todayISO();
    const myDates = Object.entries(byDate)
      .filter(([,list])=>list.some(c=>c.uid===currentUser.uid))
      .map(([date])=>date);
    const doneToday = myDates.includes(today);

    if(ch.frequency==='weekly' || ch.frequency==='monthly'){
      const now = new Date();
      const periodStart = ch.frequency==='weekly' ? mondayOfWeek(now) : new Date(now.getFullYear(), now.getMonth(), 1);
      const periodStartIso = fmtISO(periodStart);
      const periodCount = myDates.filter(d=>d>=periodStartIso && d<=today).length;
      const periodTarget = ch.frequencyCount || 1;
      return {
        doneToday, periodCount, periodTarget,
        periodLabel: ch.frequency==='weekly' ? 'this week' : 'this month',
        metTarget: periodCount>=periodTarget
      };
    }
    return {doneToday, periodCount: doneToday?1:0, periodTarget:1, periodLabel:'today', metTarget:doneToday};
  }

  function mondayOfWeek(d){
    const day = (d.getDay()+6)%7; // 0=Mon, matching the app's convention elsewhere
    const monday = new Date(d);
    monday.setDate(d.getDate()-day);
    monday.setHours(0,0,0,0);
    return monday;
  }

  function renderChallengesList(){
    const container = document.getElementById('groupChallengesList');
    const isOwner = activeGroup && currentUser && activeGroup.ownerUid===currentUser.uid;
    document.getElementById('btnNewChallenge').style.display = isOwner ? '' : 'none';

    if(activeChallenges.length===0){
      container.innerHTML = `<div class="card mb-16">
        <p class="text-sm text-muted mb-4">No active challenges yet.</p>
        ${isOwner ? '' : '<p class="text-sm text-faint">Waiting on the group owner to set one.</p>'}
      </div>`;
      return;
    }

    container.innerHTML = activeChallenges.map(ch=>{
      const entry = challengeCompletions[ch.id];
      const byDate = entry ? entry.byDate : {};
      const progress = computeChallengeProgress(ch, byDate);
      const today = todayISO();
      const inRange = today >= ch.startDate && today <= ch.endDate;
      const isPastEnd = today > ch.endDate;
      const freqLabel = ch.frequency==='weekly' ? `${ch.frequencyCount||1}x per week`
        : ch.frequency==='monthly' ? `${ch.frequencyCount||1}x per month`
        : 'Daily';
      const progressText = ch.frequency==='daily'
        ? (progress.doneToday ? '✓ Done today' : 'Not done today')
        : `${progress.periodCount}/${progress.periodTarget} ${progress.periodLabel}${progress.metTarget?' ✓':''}`;

      return `<div class="card mb-12">
        <div class="settings-row-label">${escapeHtml(ch.title)}</div>
        ${ch.targetLabel ? `<div class="text-sm text-muted">${escapeHtml(ch.targetLabel)}</div>` : ''}
        <div class="text-sm text-faint mt-4">${freqLabel} · ${fmtRange(ch.startDate, ch.endDate)}${isPastEnd?' · Ended':''}</div>
        <div class="text-sm mt-8" style="color:${progress.metTarget?'var(--positive)':'var(--text-muted)'};">${progressText}</div>
        <div class="quick-actions mt-12" style="margin-bottom:0;">
          ${inRange ? `<button class="btn btn-primary btn-sm" style="flex:1;" data-mark-done="${ch.id}" ${progress.doneToday?'disabled':''}>${progress.doneToday?'✓ Done for today':'Mark today done'}</button>` : ''}
          ${isOwner ? `<button class="btn btn-secondary btn-sm" data-end-challenge="${ch.id}">End</button>` : ''}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('[data-mark-done]').forEach(btn=>{
      btn.addEventListener('click', ()=>markChallengeDone(btn.dataset.markDone));
    });
    container.querySelectorAll('[data-end-challenge]').forEach(btn=>{
      btn.addEventListener('click', ()=>endChallenge(btn.dataset.endChallenge));
    });
  }

  function fmtRange(startIso, endIso){
    const opts = {month:'short', day:'numeric'};
    return `${parseISO(startIso).toLocaleDateString(undefined,opts)} – ${parseISO(endIso).toLocaleDateString(undefined,opts)}`;
  }

  async function createChallenge(){
    const title = document.getElementById('challengeTitleInput').value.trim();
    const targetLabel = document.getElementById('challengeTargetInput').value.trim();
    const startDate = document.getElementById('challengeStartInput').value;
    const endDate = document.getElementById('challengeEndInput').value;
    const frequency = selectedChallengeFreq;
    const frequencyCount = frequency==='daily' ? 1 : Math.max(1, +document.getElementById('challengeFreqCountInput').value || 1);
    if(!title){ toast('Give the challenge a name'); return; }
    if(!startDate || !endDate || startDate > endDate){ toast('Check the challenge dates'); return; }
    try{
      // No longer deactivates other challenges — multiple can run at once,
      // each with its own independent completions and calendar view.
      await addDoc(collection(db, 'groups', activeGroupId, 'challenges'), {
        title, targetLabel, startDate, endDate, frequency, frequencyCount,
        createdBy: currentUser.uid, createdAt: Date.now(), active: true
      });
      ui().closeSheet('sheetNewChallenge');
      toast('Challenge created');
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} set a new challenge: ${title}`,
          tags: ['triangular_flag_on_post']
        });
      }
    }catch(e){
      console.error(e);
      toast('Could not create challenge');
    }
  }

  // Owner-only: moves a challenge out of the active set (and into history)
  // without deleting its data — members immediately lose the ability to
  // mark it done, but the calendar/tally stay intact for the history view.
  async function endChallenge(challengeId){
    const ch = activeChallenges.find(c=>c.id===challengeId);
    if(!ch) return;
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'End this challenge?', message:`"${ch.title}" will move to history. Members can no longer mark it done.`, confirmLabel:'End challenge', danger:false
    }) : confirm(`End "${ch.title}"?`);
    if(!ok) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId, 'challenges', challengeId), {active:false, endedAt: Date.now()});
      toast('Challenge ended');
    }catch(e){
      console.error(e);
      toast('Could not end challenge');
    }
  }

  function notifyTeammateCompletion(c){
    toast(`${firstName(c.displayName)} completed today's challenge 🔥`);
    try{
      if('Notification' in window && Notification.permission==='granted'){
        new Notification(`${activeGroup.name}`, {
          body: `${firstName(c.displayName)} just completed today's challenge`,
          tag: 'group-completion-' + activeGroupId
        });
      }
    }catch(e){ /* notifications are a nice-to-have here, never fatal */ }
  }

  async function markChallengeDone(challengeId){
    const ch = activeChallenges.find(c=>c.id===challengeId);
    if(!ch || !currentUser) return;
    const date = todayISO();
    const id = `${date}_${currentUser.uid}`;
    try{
      await setDoc(doc(db, 'groups', activeGroupId, 'challenges', challengeId, 'completions', id), {
        uid: currentUser.uid,
        date,
        displayName: currentUser.name || 'Member',
        color: (activeMembers.find(m=>m.uid===currentUser.uid)||{}).color || PALETTE[0],
        completedAt: Date.now()
      });
      toast('Nice work — marked done for today');
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} completed today's challenge: ${ch.title}`,
          tags: ['fire']
        });
      }
    }catch(e){
      console.error(e);
      toast('Could not save — try again');
    }
  }

  /* ---------------- challenge history ---------------- */
  // A closed-book view — fetched once per open (getDocs, not a live
  // listener) since ended challenges never change again. Falls back to the
  // displayName/color stored on each completion for anyone no longer in
  // activeMembers (e.g. they've since left the group), so the tally still
  // shows who they were rather than silently dropping their check-ins.
  async function showChallengeHistorySheet(){
    if(!activeGroupId) return;
    ui().openSheet('sheetChallengeHistory');
    const content = document.getElementById('challengeHistoryContent');
    content.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;
    try{
      const snap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges'));
      const today = todayISO();
      const ended = snap.docs
        .map(d=>({id:d.id, ...d.data()}))
        .filter(ch=>!ch.active || ch.endDate < today)
        .sort((a,b)=>(b.endedAt||b.createdAt||0)-(a.endedAt||a.createdAt||0));

      if(ended.length===0){
        content.innerHTML = `<p class="text-sm text-muted">No past challenges yet.</p>`;
        return;
      }

      const cards = await Promise.all(ended.map(async ch=>{
        const compSnap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges', ch.id, 'completions'));
        const countByUid = {}, nameByUid = {}, colorByUid = {};
        compSnap.forEach(d=>{
          const c = d.data();
          countByUid[c.uid] = (countByUid[c.uid]||0)+1;
          nameByUid[c.uid] = c.displayName;
          colorByUid[c.uid] = c.color;
        });
        const allUids = new Set([...activeMembers.map(m=>m.uid), ...Object.keys(countByUid)]);
        const tally = Array.from(allUids).map(uid=>{
          const m = activeMembers.find(x=>x.uid===uid);
          return {
            name: firstName(m ? m.displayName : (nameByUid[uid]||'Member')),
            color: m ? m.color : (colorByUid[uid]||PALETTE[0]),
            count: countByUid[uid]||0
          };
        }).sort((a,b)=>b.count-a.count);
        const freqLabel = ch.frequency==='weekly' ? `${ch.frequencyCount||1}x/week` : ch.frequency==='monthly' ? `${ch.frequencyCount||1}x/month` : 'Daily';

        return `<div class="card mb-12">
          <div class="settings-row-label">${escapeHtml(ch.title)}</div>
          <div class="text-sm text-faint mb-8">${freqLabel} · ${fmtRange(ch.startDate, ch.endDate)}</div>
          ${tally.map(t=>`<div class="row" style="padding:4px 0;">
            <div style="display:flex; align-items:center; gap:8px;"><span class="group-color-dot" style="background:${t.color};"></span>${escapeHtml(t.name)}</div>
            <span class="text-sm text-muted">${t.count} check-in${t.count!==1?'s':''}</span>
          </div>`).join('')}
        </div>`;
      }));
      content.innerHTML = cards.join('');
    }catch(e){
      console.error(e);
      content.innerHTML = `<p class="text-sm text-muted">Could not load history.</p>`;
    }
  }

  /* ---------------- activity feed (reactions) ----------------
     A reverse-chronological feed of check-ins across every challenge in
     the group — active ones read live from the same data the challenge
     cards already listen to (no extra Firestore reads), ended ones are
     fetched once per sheet-open the same way challenge history is (a
     closed book — nothing there changes on its own). Each item carries a
     small emoji-reaction bar; reactions live in a `reactions: {uid:emoji}`
     map on the completion doc itself. */
  const REACTION_EMOJI = ['👍','🔥','💪','🎉','👏'];

  async function showActivityFeedSheet(){
    if(!activeGroupId) return;
    ui().openSheet('sheetActivityFeed');
    const container = document.getElementById('activityFeedContent');
    container.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;

    const items = [];
    activeChallenges.forEach(ch=>{
      const entry = challengeCompletions[ch.id];
      if(!entry) return;
      Object.values(entry.byDate).flat().forEach(c=>{
        items.push({...c, challengeId: ch.id, challengeTitle: ch.title, completionId: `${c.date}_${c.uid}`});
      });
    });

    try{
      const snap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges'));
      const today = todayISO();
      const ended = snap.docs.map(d=>({id:d.id, ...d.data()})).filter(ch=>!ch.active || ch.endDate < today);
      const endedGroups = await Promise.all(ended.map(async ch=>{
        const compSnap = await getDocs(collection(db, 'groups', activeGroupId, 'challenges', ch.id, 'completions'));
        return compSnap.docs.map(d=>({...d.data(), challengeId: ch.id, challengeTitle: ch.title, completionId: d.id}));
      }));
      endedGroups.forEach(list=>items.push(...list));
    }catch(e){
      console.error('activity feed history fetch failed', e);
    }

    items.sort((a,b)=>(b.completedAt||0)-(a.completedAt||0));
    activityFeedItems = items.slice(0, 40);
    renderActivityFeedList();
  }

  function renderActivityFeedList(){
    const container = document.getElementById('activityFeedContent');
    if(!container) return;
    if(activityFeedItems.length===0){
      container.innerHTML = `<p class="text-sm text-muted">No check-ins yet.</p>`;
      return;
    }
    container.innerHTML = activityFeedItems.map(item=>{
      const reactions = item.reactions || {};
      const counts = {};
      Object.values(reactions).forEach(e=>{ counts[e] = (counts[e]||0)+1; });
      const myReaction = currentUser ? reactions[currentUser.uid] : null;
      return `<div class="card mb-12">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="group-color-dot" style="background:${item.color};"></span>
          <div style="min-width:0;">
            <div class="text-sm" style="font-weight:600;">${escapeHtml(firstName(item.displayName))} <span style="font-weight:400; color:var(--text-muted);">completed</span> ${escapeHtml(item.challengeTitle)}</div>
            <div class="text-sm text-faint">${relativeTime(item.completedAt)}</div>
          </div>
        </div>
        <div class="activity-reaction-row mt-8">
          ${REACTION_EMOJI.map(e=>`
            <button type="button" class="activity-reaction-btn ${myReaction===e?'active':''}" data-react="${item.challengeId}|${item.completionId}|${e}">
              ${e}${counts[e]?`<span class="activity-reaction-count">${counts[e]}</span>`:''}
            </button>
          `).join('')}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('[data-react]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const [challengeId, completionId, emoji] = btn.dataset.react.split('|');
        toggleReaction(challengeId, completionId, emoji);
      });
    });
  }

  // Applies live updates from the already-subscribed active-challenge
  // completions listeners onto whatever's currently cached for the feed —
  // keeps reactions on active challenges' items live without any extra
  // Firestore reads. Ended-challenge items only refresh on next sheet-open.
  function syncActivityFeedFromActiveChallenges(){
    if(activityFeedItems.length===0) return;
    let changed = false;
    activeChallenges.forEach(ch=>{
      const entry = challengeCompletions[ch.id];
      if(!entry) return;
      Object.values(entry.byDate).flat().forEach(c=>{
        const completionId = `${c.date}_${c.uid}`;
        const idx = activityFeedItems.findIndex(i=>i.challengeId===ch.id && i.completionId===completionId);
        if(idx>=0){
          activityFeedItems[idx] = {...activityFeedItems[idx], ...c};
          changed = true;
        }
      });
    });
    if(changed) renderActivityFeedList();
  }

  async function toggleReaction(challengeId, completionId, emoji){
    if(!currentUser) return;
    const item = activityFeedItems.find(i=>i.challengeId===challengeId && i.completionId===completionId);
    if(!item) return;
    const reactions = {...(item.reactions||{})};
    const mine = reactions[currentUser.uid];
    const removing = mine===emoji;
    if(removing) delete reactions[currentUser.uid];
    else reactions[currentUser.uid] = emoji;

    item.reactions = reactions; // optimistic — feels instant, corrected on next fetch if the write below ever fails
    renderActivityFeedList();

    try{
      const ref = doc(db, 'groups', activeGroupId, 'challenges', challengeId, 'completions', completionId);
      await updateDoc(ref, { [`reactions.${currentUser.uid}`]: removing ? deleteField() : emoji });
    }catch(e){
      console.error(e);
      toast('Could not save reaction');
    }
  }

  function relativeTime(ts){
    if(!ts) return '';
    const mins = Math.floor((Date.now()-ts)/60000);
    if(mins<1) return 'just now';
    if(mins<60) return `${mins}m ago`;
    const hrs = Math.floor(mins/60);
    if(hrs<24) return `${hrs}h ago`;
    const days = Math.floor(hrs/24);
    if(days<7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined,{month:'short', day:'numeric'});
  }

  /* ---------------- completions + calendar ---------------- */
  function renderCalendarChallengeSelector(){
    const wrap = document.getElementById('calChallengeSelector');
    if(activeChallenges.length<=1){
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    wrap.innerHTML = activeChallenges.map(ch=>`
      <button type="button" class="btn btn-secondary btn-sm challenge-freq-chip ${ch.id===selectedCalendarChallengeId?'selected':''}" data-cal-challenge="${ch.id}" style="white-space:nowrap;">${escapeHtml(ch.title)}</button>
    `).join('');
    wrap.querySelectorAll('[data-cal-challenge]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        selectedCalendarChallengeId = btn.dataset.calChallenge;
        renderCalendarChallengeSelector();
        renderGroupCalendar();
      });
    });
  }

  function renderGroupCalendar(){
    if(!activeGroupId) return;
    const year = calCursor.getFullYear(), month = calCursor.getMonth();
    document.getElementById('calGroupMonthLabel').textContent = calCursor.toLocaleDateString(undefined,{month:'long', year:'numeric'});

    const dowRow = document.getElementById('calGroupDowRow');
    dowRow.innerHTML = ['M','T','W','T','F','S','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');

    const grid = document.getElementById('calGroupGrid');
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay()+6)%7;
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const today = new Date();
    const byDate = (challengeCompletions[selectedCalendarChallengeId] || {}).byDate || {};

    let cells = [];
    for(let i=0;i<startOffset;i++) cells.push(null);
    for(let d=1; d<=daysInMonth; d++) cells.push(d);

    grid.innerHTML = cells.map(d=>{
      if(d===null) return `<div class="cal-cell empty"></div>`;
      const cellDate = new Date(year,month,d);
      const iso = fmtISO(cellDate);
      const isToday = iso===fmtISO(today);
      const completions = byDate[iso] || [];
      const dots = completions.slice(0,8).map(c=>`<span class="group-cal-dot" style="background:${c.color}"></span>`).join('');
      return `<div class="cal-cell ${isToday?'today':''} ${completions.length?'has-completions':''}" data-date="${iso}">
        <span class="num">${d}</span>
        <div class="group-cal-dots">${dots}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
      cell.addEventListener('click', ()=>openDaySheet(cell.dataset.date));
    });

    // Legend: one row per member and their color, so dot colors are readable
    // at a glance without needing to tap into every day.
    const legend = document.getElementById('calGroupLegend');
    legend.innerHTML = activeMembers.map(m=>`
      <div class="cal-legend-item"><div class="cal-legend-swatch" style="background:${m.color}; border:none;"></div>${escapeHtml(firstName(m.displayName))}</div>
    `).join('');
  }

  function openDaySheet(dateIso){
    const byDate = (challengeCompletions[selectedCalendarChallengeId] || {}).byDate || {};
    const completions = byDate[dateIso] || [];
    const completedUids = new Set(completions.map(c=>c.uid));
    const d = parseISO(dateIso);
    document.getElementById('dayCompletionsTitle').textContent = d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});

    const list = document.getElementById('dayCompletionsList');
    if(activeMembers.length===0){
      list.innerHTML = `<p class="text-sm text-muted">No members yet.</p>`;
    } else {
      list.innerHTML = activeMembers.map(m=>{
        const done = completedUids.has(m.uid);
        return `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--border-soft);">
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="group-color-dot" style="background:${m.color}; opacity:${done?1:0.35};"></span>
            <span style="${done?'':'color:var(--text-faint);'}">${escapeHtml(m.displayName)}${isOwnerUid(m.uid) ? ' <span class="group-crown" title="Group owner">👑</span>' : ''}</span>
          </div>
          <span style="${done?'color:var(--positive);':'color:var(--text-faint);'} font-size:13px;">${done?'✓ Done':'—'}</span>
        </div>`;
      }).join('');
    }
    ui().openSheet('sheetDayCompletions');
  }

  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  document.addEventListener('DOMContentLoaded', init);
  if(document.readyState!=='loading') init();

  window.GymGroups = { onShow, getHomeChallengeCards, openGroupFromHome };
})();

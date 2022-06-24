// Import Firebase modules:
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.6/firebase-app.js";
import { getDatabase, set, get, ref, query, onValue, child, push, remove, onDisconnect } from "https://www.gstatic.com/firebasejs/9.6.6/firebase-database.js";

// Firebase configuration:
const firebaseConfig = {
  apiKey: "AIzaSyBmwruzGgrCRJBalfo0dtta3Eu9qQ3d02M",
  authDomain: "distributed-text-editor-dc48e.firebaseapp.com",
  projectId: "distributed-text-editor-dc48e",
  storageBucket: "distributed-text-editor-dc48e.appspot.com",
  messagingSenderId: "229680002194",
  appId: "1:229680002194:web:21932142c96df2eb43a24b"
};


// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let pending = [];
let applied = [];
let uid = "User" + getCurrentTime().toString() + Math.floor(Math.random() * Math.pow(10, 5)).toString();
let lastKeyPress;
let lastChange;
let lastUpdated;
let prevContentUpdated = 0;
let contentCheck = 0;
let lastInputTimeStamp = 0;
let activeVertex = false;
let stack = {
  undo: [],
  redo: []
};
let userCache = {};
let actvStyles = [];

let contentCheckDelay = 5;
let syncCount = 0;


window.addEventListener("load", async function() {

  // If the client disconnects, clear their user data:
  onDisconnect(ref(db, `users/${uid}`)).remove();

  // Get the stored text for the editor:
  let content = (await acquireData("vertexes/editor/content", function(err) { console.error(err); })) || { vertex: "editor", text: "\n", style: { bold: "", italic: "", underline: "", strikethrough: "" }, uid: "", updated: 0 };
  let userData = (await acquireData("users", function(err) { console.error(err); })) || {};
  setText(document.getElementById("editor"), content.text + (content.text[content.text.length - 1] !== "\n" ? "\n" : ""), { start: 0, end: 0 }, true);
  applyStyle(document.getElementById("editor"), content.style);
  overrideLinks(document.getElementById("editor"), content.links);
  setCrsrs(userData);

  // Update the "applied" values:
  let changesObj = await acquireData("changes", function(err) { console.error(err); });
  for (let i in changesObj) {
    applied.push(i);
  }

  // Set the user data:
  set(ref(db, `users/${uid}`), {
    status: "active",
    vertex: false,
    cursor: false,
    changed: new Date().getTime(),
    updated: new Date().getTime()
  });

  // Get user data:
  onValue(ref(db, "users"), (snapshot) => {
    const userData = snapshot.val();

    if (uid === "_disconnected")
      return;

    // Check for disconnects:
    if (!userData || !userData[uid] || !userData[uid].status) {
      uid = "_disconnected";
      alert("You have been disconnected from the server.\n\nIf this is a recurring issue, there might be something wrong with the editor's content or your internet connection."); // [NOTE]
      location.reload(true);
      return;
    }

    // Remove disconnected user data:
    if (userData["_disconnected"]) {
      remove(ref(db, `users/_disconnected`));
      delete userData["_disconnected"];
    }

    // Update user status:
    let statusData = {
      active: 0,
      idle: 0
    };
    for (let u in userData) {
      statusData[userData[u].status]++;
    }

    document.getElementsByClassName("users")[0].innerHTML = `Active: ${statusData.active} &nbsp&nbsp|&nbsp&nbsp Idle: ${statusData.idle}`;

    // Update cursor positions:
    setCrsrs(userData);

  });

  // Get new changes coming in:
  onValue(ref(db, "changes"), (snapshot) => {
    const changes = snapshot.val();
    checkChanges(changes);
  });

  // Check periodically to ensure the clients are all synced properly:
  setInterval(async function() {

    let content = (await acquireData("vertexes/editor/content", function(err) { console.error(err); })) || { vertex: "editor", text: "\n", style: { bold: "", italic: "", underline: "", strikethrough: "" }, uid: "", updated: 0 };
    sync(document.getElementById("editor"), content);
  }, 250);

  // Check for idle users and remove disconnected users:
  setInterval(async function() {

    let users = (await acquireData("users", function(err) { console.error(err); })) || { vertex: "editor", text: "\n", style: { bold: "", italic: "", underline: "", strikethrough: "" }, uid: "", updated: 0 };

    // Check if a user is idle or should be kicked:
    for (let u in users) {

      // Set status to idle if no changes have been made for more than 5 minutes:
      if (users[u].status === "active" && getCurrentTime() - users[u].changed >= 5 * 60 * 1000) {
        set(ref(db, `users/${u}/status`), "idle");
      }

      // Remove user from the database if they have not recieved an update for more than 10 minutes [NOTE when implementing into real thing, take the last updated time into consideration (for example, a user should only be kicked if they have not recieved an update 5 minutes after the last time the content itself was updated)]:
      if (!users[u].status || getCurrentTime() - users[u].updated >= 10 * 60 * 1000) {
        remove(ref(db, `users/${u}`));
      }
    }


  }, 5 * 1000);
});

async function sync(el, content) {

  // Ignore if the update is old:
  if (content.updated >= prevContentUpdated) {
    prevContentUpdated = content.updated;
  } else {
    return;
  }

  // Don't sync while applying changes:
  if (getCurrentTime() - lastChange <= 1000)
    return;

  // Don't sync while the user is typing:
  if (getCurrentTime() - lastKeyPress <= 1000)
    return;

  // Ignore if the update was by the same user:
  if (content.uid === uid)
    return;

  // Check if the client is synced (this checks the text, styling, and links):
  if (content.text !== el.textContent || content.style.bold !== acquireMetaTag(el, "bold") || content.style.italic !== acquireMetaTag(el, "italic") || content.style.underline !== acquireMetaTag(el, "underline") || content.style.strikethrough !== acquireMetaTag(el, "strikethrough") || JSON.stringify(content.links) !== JSON.stringify(acquireMetaTag(el, "links"))) {

    // Client is not synced; take note of this:
    contentCheck++;

    // If the client is not synced for 5 times in total (~1.25 seconds), sync them:
    if (contentCheck >= contentCheckDelay) {

      console.warn("Sync");

      // Store the caret position to perserve it for later:
      let caretPos = getCrsrPos(document.getElementById("editor"));

      // Grab user data to sync cursors:
      let userData = (await acquireData("users", function(err) { console.error(err); })) || {};

      // Sync everything:
      document.getElementById("editor").textContent = "";
      setText(el, content.text + (content.text[content.text.length - 1] !== "\n" ? "\n" : ""), { start: 0, end: 0 }, true);
      applyStyle(el, content.style);
      overrideLinks(el, content.links);
      setCrsrs(userData);
      setCrsrPos(el, caretPos);

      contentCheck = 0;
      syncCount++;

      // Disconnect the user if sync is unable to fix the issue:
      if (syncCount >= 10)
        remove(ref(db, `users/${uid}`));
    }

  // Client is synced; reset the counter:
  } else {
    contentCheck = 0;
    syncCount = 0;
  }
}

function actvtBtns() {

  // Reset active classes:
  while (document.getElementsByClassName("button-active").length > 0)
    document.getElementsByClassName("button-active")[0].classList.remove("button-active");

  // Add the classes back to any active styles:
  for (let i = 0; i < actvStyles.length; i++) {
    document.getElementById(actvStyles[i]).classList.add("button-active");
  }
}

















document.getElementById("editor").addEventListener("input", function(e) {

  // Update cursor position in Firebase (after event finishes):
  setTimeout(function() {
    set(ref(db, `users/${uid}/cursor`), getCrsrPos(document.getElementById("editor")));
  }, 0);

  // Input was due to a recursive call from insertFromDrop, insertReplacementText, or insertCompositionText and should be ignored:
  if (Math.abs(lastInputTimeStamp - e.timeStamp) <= 1000 || lastInputTimeStamp === Infinity) {
    return;
  }

  // Prevent undo/redo from the context menu (since the custom stack should be used instead):
  if (e.inputType === "historyUndo") {

    // Delete the undo:
    let caretPos = getCrsrPos(this);
    setText(this, "", caretPos);

    // Then alert the user to use "Ctrl + Z" instead:
    alert("Undo from the context menu is not supported.\n\nPlease use \"Ctrl + Z\" instead.");
    return;
  }
  if (e.inputType === "historyRedo") {

    // Undo the redo:
    lastInputTimeStamp = e.timeStamp;
    document.execCommand("undo");

    // Then alert the user to use "Ctrl + Y" instead:
    alert("Redo from the context menu is not supported.\n\nPlease use \"Ctrl + Y\" instead.");
    return;
  }

  // Handle dropped text:
  if (e.inputType === "insertFromDrop") {

    // Perform the insertion (since the dropped text is selected after the insertion):
    let insertCrsrPos = getCrsrPos(this);

    buffer({
      vertex: "editor",
      action: "insert",
      content: this.textContent.substring(insertCrsrPos.start, insertCrsrPos.end),
      index: {
        start: insertCrsrPos.start,
        end: insertCrsrPos.start
      },
      surrounding: {
        before: this.textContent[insertCrsrPos.start - 1] || false,
        after: (insertCrsrPos.end === this.textContent.length - 1 && this.textContent[insertCrsrPos.end] === "\n") ? false : (this.textContent[insertCrsrPos.end] || false)
      }
    });

    setText(this, this.textContent.substring(insertCrsrPos.start, insertCrsrPos.end), { start: insertCrsrPos.start, end: insertCrsrPos.start });

    // Then undo the insertion:
    lastInputTimeStamp = e.timeStamp;
    document.execCommand("undo");

    // Then remove where the text originated from (since the original text is selected after the undo):
    let preCrsrPos = getCrsrPos(this);

    if (this.textContent.substring(preCrsrPos.start, preCrsrPos.end).length > 0) {

      buffer({
        vertex: "editor",
        action: "replace",
        contentPre: this.textContent.substring(preCrsrPos.start, preCrsrPos.end),
        content: "",
        index: {
          start: preCrsrPos.start,
          end: preCrsrPos.end
        },
        surrounding: {
          before: this.textContent[preCrsrPos.start - 1] || false,
          after: (preCrsrPos.end === this.textContent.length - 1 && this.textContent[preCrsrPos.end] === "\n") ? false : (this.textContent[preCrsrPos.end] || false)
        }
      });

      setText(this, "", preCrsrPos, true);
    }

    setCrsrPos(this, { start: insertCrsrPos.end, end: insertCrsrPos.end });

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
    return;
  }

  // Handle spelling corrections:
  if (e.inputType === "insertReplacementText") {

    // Start by undoing the spelling correction (to determine the original text):
    lastInputTimeStamp = e.timeStamp;
    document.execCommand("undo");

    // The original text is now selected:
    let preCaretPos = getCrsrPos(this);
    let contentPre = this.textContent.substring(preCaretPos.start, preCaretPos.end);
    let classes = (this.childNodes[preCaretPos.start] && this.childNodes[preCaretPos.start].classList) ? [...this.childNodes[preCaretPos.start].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];

    // Then, redo the spelling correction (to determine the new text):
    lastInputTimeStamp = e.timeStamp;
    document.execCommand("redo");

    // The cursor will always be placed after the end of the spelling correction; we know where the spelling correction starts because the spelling correction is always inserted starting at the beginning of the previous selection:
    let postCaretPos = { start: preCaretPos.start, end: getCrsrPos(this).end }; // Note that since the spelling correction is stored in just one element, the end node is really the start + 1
    let content = this.textContent.substring(postCaretPos.start, postCaretPos.end);

    buffer({
      vertex: "editor",
      action: "replace",
      contentPre: contentPre,
      content: content,
      index: {
        start: preCaretPos.start,
        end: preCaretPos.end
      },
      surrounding: {
        before: this.textContent[preCaretPos.start - 1] || false,
        after: (postCaretPos.end === this.textContent.length - 1 && this.textContent[postCaretPos.end] === "\n") ? false : (this.textContent[postCaretPos.end] || false)
      }
    });

    setText(this, content, { start: preCaretPos.start, end: preCaretPos.start + 1 }, false, classes);

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
    return;
  }
});
















async function acquireData(path, err) {

  let data;
  const dbref = ref(db);

  await get(child(dbref, path)).then((snapshot) => {
    if (!snapshot.exists())
      return;

    data = snapshot.val();
  }).catch((error) => {
    err(error);
    console.error(error);
  });

  return data;
}

function buffer(c, isUndoRedo) {

  c.uid = uid;
  c.timestamp = getCurrentTime();
  c.style = !isUndoRedo ? actvStyles : false;

  pending.push(c);

  // Handle the undo/redo stack:
  if (!isUndoRedo) {
    stack.undo.push(c);
    stack.redo = [];
  }
}

function getCurrentTime() {
  return Date.now();
}

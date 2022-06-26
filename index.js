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
  let editorMessage;
  if(content.text[content.text.length - 1] !== "\n"){
    editorMessage = "\n";
  }
  else{
    editorMessage ="";
  }
  setText(document.getElementById("editor"), content.text + editorMessage, { start: 0, end: 0 }, true);
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
      alert("You have been disconnected from the server.\n\nYou will be reconnected automatically.");
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

      // Set status to idle if no changes have been made for more than 3 minutes:
      if (users[u].status === "active" && getCurrentTime() - users[u].changed >= 3 * 60 * 1000) {
        set(ref(db, `users/${u}/status`), "idle");
      }

      // Remove user from the database if they have not recieved an update for more than 5 minutes
      if (!users[u].status || getCurrentTime() - users[u].updated >= 5 * 60 * 1000) {
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
      if (syncCount >= 30)
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

function getActvStyles(el) {

  let caretPos = getCrsrPos(el);

  // Determine what the current active styles should be:
  // No text is selected; get the style of the character before:
  if (caretPos.start === caretPos.end) {
    return (el.childNodes[caretPos.start - 1] && el.childNodes[caretPos.start - 1].classList) ? [...el.childNodes[caretPos.start - 1].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];

  // Text is being selected; get the styles that apply to all characters in the selection:
  }
}

document.getElementById("editor").addEventListener("keydown", async function(e) {

  // Update cursor position in Firebase (after event finishes):
  setTimeout(function() {
    set(ref(db, `users/${uid}/cursor`), getCrsrPos(document.getElementById("editor")));

    // Handle arrow keys and "Ctrl + A":
    if (e.keyCode === 37 || e.keyCode === 38 || e.keyCode === 39 || e.keyCode === 40 || (e.ctrlKey && e.keyCode === 65)) {
      actvStyles = getActvStyles(document.getElementById("editor"));
      actvtBtns();

      set(ref(db, `users/${uid}/changed`), getCurrentTime());
      set(ref(db, `users/${uid}/status`), "active");
    }
  }, 0);

  // Close the link creator:
  while (document.getElementsByClassName("link-creator").length > 0) {
    document.getElementsByClassName("link-creator")[0].remove();
  }
  clrSelection();

  // Prevent defualt behavior of most keys (alpha-numerical, delete/backspace, undo/redo, styling keys):
  if ((!e.ctrlKey && e.key.length === 1) || (e.keyCode === 8 || e.keyCode === 46 || e.keyCode === 13) || (e.ctrlKey && (e.keyCode === 90 || e.keyCode === 89 || e.keyCode === 66 || e.keyCode === 73 || e.keyCode === 85 || e.keyCode === 83 || e.keyCode === 75)))
    e.preventDefault();

  let crsrPos = getCrsrPos(this);
  let key;

  // Handle enter:
  if (e.keyCode === 13)
    key = "\n";

  // Handle backspace / delete:
  if (e.keyCode === 8 && crsrPos.end > 0 || e.keyCode === 46 && crsrPos.end < this.textContent.length - 1) {

    // No selection:
    if (crsrPos.start === crsrPos.end) {

      // Handle normal backspace / delete:
      if (!e.ctrlKey) {

        // Update active styles:
        actvStyles = (this.childNodes[crsrPos.start - (e.keyCode === 8 ? 1 : 0)] && this.childNodes[crsrPos.start - (e.keyCode === 8 ? 1 : 0)].classList) ? [...this.childNodes[crsrPos.start - (e.keyCode === 8 ? 1 : 0)].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];
        actvtBtns();

        buffer({
          vertex: "editor",
          action: "delete",
          contentPre: this.textContent[crsrPos.start - (e.keyCode === 8 ? 1 : 0)],
          index: {
            start: crsrPos.start - (e.keyCode === 8 ? 1 : 0),
            end: crsrPos.start - (e.keyCode === 8 ? 1 : 0)
          },
          surrounding: {
            before: this.textContent[crsrPos.start - 1 - (e.keyCode === 8 ? 1 : 0)] || false,
            after: ((crsrPos.start + (e.keyCode === 46 ? 1 : 0)) === this.textContent.length - 1 && this.textContent[crsrPos.start + (e.keyCode === 46 ? 1 : 0)] === "\n") ? false : (this.textContent[crsrPos.start + (e.keyCode === 46 ? 1 : 0)] || false)
          }
        });

        lastKeyPress = getCurrentTime();
        pushChanges(lastKeyPress);

        setText(this, "", { start: crsrPos.start - (e.keyCode === 8 ? 1 : 0), end: crsrPos.end + (e.keyCode === 46 ? 1 : 0) });
      }
    // Selection:
    } else {

      // Update active styles:
      actvStyles = (this.childNodes[crsrPos.start] && this.childNodes[crsrPos.start].classList) ? [...this.childNodes[crsrPos.start].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];
      actvtBtns();

      buffer({
        vertex: "editor",
        action: "replace",
        contentPre: this.textContent.substring(crsrPos.start, crsrPos.end),
        content: "",
        index: {
          start: crsrPos.start,
          end: crsrPos.end
        },
        surrounding: {
          before: this.textContent[crsrPos.start - 1] || false,
          after: (crsrPos.end === this.textContent.length - 1 && this.textContent[crsrPos.end] === "\n") ? false : (this.textContent[crsrPos.end] || false)
        }
      });

      lastKeyPress = getCurrentTime();
      pushChanges(lastKeyPress);

      setText(this, "", crsrPos);
    }
  }

  // Handle undo/redo:
  // Ctrl + Z (Undo):
  if (e.ctrlKey && !e.shiftKey && e.keyCode === 90 && stack.undo.length > 0) {
    executeUndo();
  }

  // Ctrl + Shift + Z or Ctrl + Y (Redo):
  if ((e.ctrlKey && e.shiftKey && e.keyCode === 90 || e.ctrlKey && e.keyCode === 89) && stack.redo.length > 0) {
    executeRedo();
  }

  // Handle styling keys and link keys:
  // Ctrl + B (Bold):
  if (e.ctrlKey && !e.shiftKey && e.keyCode === 66) {

    // No text is selected:
    if (crsrPos.start === crsrPos.end) {
      if (actvStyles.indexOf("bold") === -1) {
        actvStyles.push("bold");
      } else {
        actvStyles.splice(actvStyles.indexOf("bold"), 1);
      }

      actvtBtns();

    // Text is selected:
    } else {
      applySelectedStyle(document.getElementById("editor"), "bold");
    }
  }

  // Ctrl + I (Italic):
  if (e.ctrlKey && !e.shiftKey && e.keyCode === 73) {

    // No text is selected:
    if (crsrPos.start === crsrPos.end) {
      if (actvStyles.indexOf("italic") === -1) {
        actvStyles.push("italic");
      } else {
        actvStyles.splice(actvStyles.indexOf("italic"), 1);
      }

      actvtBtns();

    // Text is selected:
    } else {
      applySelectedStyle(document.getElementById("editor"), "italic");
    }
  }

  // Ctrl + U (Underline):
  if (e.ctrlKey && !e.shiftKey && e.keyCode === 85) {

    // No text is selected:
    if (crsrPos.start === crsrPos.end) {
      if (actvStyles.indexOf("underline") === -1) {
        actvStyles.push("underline");
      } else {
        actvStyles.splice(actvStyles.indexOf("underline"), 1);
      }

      actvtBtns();

    // Text is selected:
    } else {
      applySelectedStyle(document.getElementById("editor"), "underline");
    }
  }

  // Ctrl + S (Strikethrough):
  if (e.ctrlKey && !e.shiftKey && e.keyCode === 83) {

    // No text is selected:
    if (crsrPos.start === crsrPos.end) {
      if (actvStyles.indexOf("strikethrough") === -1) {
        actvStyles.push("strikethrough");
      } else {
        actvStyles.splice(actvStyles.indexOf("strikethrough"), 1);
      }

      actvtBtns();

    // Text is selected:
    } else {
      applySelectedStyle(document.getElementById("editor"), "strikethrough");
    }
  }

  // Ctrl + K (Link):
  if (e.ctrlKey && !e.shiftKey && e.keyCode === 75) {
    if (crsrPos.start !== crsrPos.end) {
      createDocLink(this);
    }
  }

  // If we aren't dealing with a normal key, return now:
  if (e.keyCode !== 13 && (e.ctrlKey || e.altKey || e.key.length > 1))
    return;

  // Handle typing/selecting text and typing:
  if (crsrPos.start === crsrPos.end) {
    buffer({
      vertex: "editor",
      action: "type",
      content: key || e.key,
      index: {
        start: crsrPos.end,
        end: crsrPos.end
      },
      surrounding: {
        before: this.textContent[crsrPos.end - 1] || false, // The first part of this conditional is to ignore the last "\n" that HTML sometimes autofills (for whatever reason):
        after: (crsrPos.end === this.textContent.length - 1 && this.textContent[crsrPos.end] === "\n") ? false : (this.textContent[crsrPos.end] || false)
      }
    });

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
  } else {
    buffer({
      vertex: "editor",
      action: "replace",
      contentPre: this.textContent.substring(crsrPos.start, crsrPos.end),
      content: key || e.key,
      index: {
        start: crsrPos.start,
        end: crsrPos.end
      },
      surrounding: {
        before: this.textContent[crsrPos.start - 1] || false,
        after: (crsrPos.end === this.textContent.length - 1 && this.textContent[crsrPos.end] === "\n") ? false : (this.textContent[crsrPos.end] || false)
      }
    });

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
  }

  setText(this, key || e.key, crsrPos);

});

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

document.getElementById("editor").addEventListener("paste", function(e) {

  // Update cursor position in Firebase (after event finishes):
  setTimeout(function() {
    set(ref(db, `users/${uid}/cursor`), getCrsrPos(document.getElementById("editor")));
  }, 0);

  let caretPos = getCrsrPos(this);

  // Clean pasted text:
  e.preventDefault();
  let textToPaste = (e.clipboardData.getData("text/plain")).split("\r\n").join("\n");

  // Push pasted text:
  if (caretPos.start === caretPos.end) {
    buffer({
      vertex: "editor",
      action: "insert",
      content: textToPaste,
      index: {
        start: caretPos.end,
        end: caretPos.end
      },
      surrounding: {
        before: this.textContent[caretPos.end - 1] || false,
        after: (caretPos.end === this.textContent.length - 1 && this.textContent[caretPos.end] === "\n") ? false : (this.textContent[caretPos.end] || false)
      }
    });

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
  } else {
    buffer({
      vertex: "editor",
      action: "replace",
      contentPre: this.textContent.substring(caretPos.start, caretPos.end),
      content: textToPaste,
      index: {
        start: caretPos.start,
        end: caretPos.end
      },
      surrounding: {
        before: this.textContent[caretPos.start - 1] || false,
        after: (caretPos.end === this.textContent.length - 1 && this.textContent[caretPos.end] === "\n") ? false : (this.textContent[caretPos.end] || false)
      }
    });

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
  }

  // Insert the text:
  setText(this, textToPaste, caretPos);

});

document.getElementById("editor").addEventListener("cut", function(e) {

  // Update cursor position in Firebase (after event finishes):
  setTimeout(function() {
    set(ref(db, `users/${uid}/cursor`), getCrsrPos(document.getElementById("editor")));
  }, 0);

  let caretPos = getCrsrPos(this);

  // Push removed text:
  if (caretPos.start === caretPos.end)
    return;

  buffer({
    vertex: "editor",
    action: "replace",
    contentPre: this.textContent.substring(caretPos.start, caretPos.end),
    content: "",
    index: {
      start: caretPos.start,
      end: caretPos.end
    },
    surrounding: {
      before: this.textContent[caretPos.start - 1] || false,
      after: (caretPos.end === this.textContent.length - 1 && this.textContent[caretPos.end] === "\n") ? false : (this.textContent[caretPos.end] || false)
    }
  });

  lastKeyPress = getCurrentTime();
  pushChanges(lastKeyPress);

});

document.getElementById("editor").addEventListener("focus", function(e) {

  // Set this to be the active vertex:
  activeVertex = "editor";
  setTimeout(function() {
    set(ref(db, `users/${uid}/cursor`), getCrsrPos(this));
    set(ref(db, `users/${uid}/vertex`), "editor");
    set(ref(db, `users/${uid}/changed`), getCurrentTime());
    set(ref(db, `users/${uid}/status`), "active");
  }, 0);

});

document.getElementById("editor").addEventListener("blur", function(e) {

  // Remove this from being the active vertex:
  setTimeout(function() {
    if (!document.activeElement.classList.contains("link-creator-element")) {
      activeVertex = false;
      set(ref(db, `users/${uid}/cursor`), false);
      set(ref(db, `users/${uid}/vertex`), false);
      set(ref(db, `users/${uid}/changed`), getCurrentTime());
      set(ref(db, `users/${uid}/status`), "active");
    }
  }, 0);

});

document.body.addEventListener("mousedown", function(e) {

  // Close the link popup if it is clicked off of:
  if (e.target.id !== "link" && !e.target.classList.contains("link-creator-element")) {
    while (document.getElementsByClassName("link-creator").length > 0) {
      document.getElementsByClassName("link-creator")[0].remove();
    }
    clrSelection();
  }

  let preCrsrPos = document.activeElement.id ? getCrsrPos(document.activeElement) : false; // [NOTE] when implementing into actual editor, additional id checks will need to be made (to ensure it is a valid vertex field)
  let preVertex = document.activeElement.id || false; // [NOTE]

  // Check for links and update cursor position in Firebase (after event finishes):
  setTimeout(function() {

    // Ensure that a valid vertex was clicked on:
    if (document.activeElement.id) { // [NOTE] when implementing into actual editor, additional id checks will need to be made (to ensure it is a valid vertex field)

      let crsrPos = document.activeElement.id ? getCrsrPos(document.activeElement) : false; // [NOTE] when implementing into actual editor, additional id checks will need to be made (to ensure it is a valid vertex field)

      // Check if the element clicked is a link:
      if (crsrPos.start === crsrPos.end && document.activeElement.childNodes[crsrPos.end].dataset.href) { // [NOTE] when implementing into actual editor, additional id checks will need to be made (to ensure it is a valid vertex field)

        // Find the start and the end of the link, then select it:
        let start, end, spans = document.activeElement.childNodes;
        for (start = crsrPos.start; start > 0; start--) {
          if (spans[start - 1].dataset.href !== spans[crsrPos.start].dataset.href)
            break;
        }
        for (end = crsrPos.start; end < document.activeElement.textContent.length; end++) {
          if (spans[end].dataset.href !== spans[crsrPos.start].dataset.href)
            break;
        }

        setCrsrPos(document.activeElement, { start: start, end: end });

        // Once this is done, open the link editor:
        createDocLink(document.activeElement, document.activeElement.childNodes[crsrPos.end].dataset.href);
      }

      if (preCrsrPos.start !== crsrPos.start || preCrsrPos.end !== crsrPos.end || preVertex !== document.activeElement.id) {
        actvStyles = getActvStyles(document.activeElement);
        actvtBtns();
      }

      // Update cursor position in Firebase:
      set(ref(db, `users/${uid}/cursor`), crsrPos);
      set(ref(db, `users/${uid}/changed`), getCurrentTime());
      set(ref(db, `users/${uid}/status`), "active");
    } else {
      actvStyles = [];
    }
  }, 0);

});
let updateThrottledCrsr = throttled(function() {
  if (!document.activeElement.id || document.activeElement.classList.contains("link-creator-element"))
    return;

  set(ref(db, `users/${uid}/cursor`), getCrsrPos(document.activeElement));
  set(ref(db, `users/${uid}/changed`), getCurrentTime());
  set(ref(db, `users/${uid}/status`), "active");
}, 100);
document.body.addEventListener("mousemove", function(e) {

  let preCrsrPos = document.activeElement.id ? getCrsrPos(document.activeElement) : false; 
  let preVertex = document.activeElement.id || false; // [NOTE]

  // Update cursor position in Firebase (after event finishes):
  setTimeout(function() {

    // Ensure that a valid vertex was clicked on:
    if (e.buttons === 1 && document.activeElement.id && !document.activeElement.classList.contains("link-creator-element")) { 

      let crsrPos = document.activeElement.id ? getCrsrPos(document.activeElement) : false;

      // Update active styles:
      if (preCrsrPos.start !== crsrPos.start || preCrsrPos.end !== crsrPos.end || preVertex !== document.activeElement.id) {
        actvStyles = getActvStyles(document.activeElement);
        actvtBtns();
      }

      // Update cursor position (throttled so it doesn't send too many updates to Firebase at once):
      updateThrottledCrsr();
    }
  }, 0);

});
document.body.addEventListener("mouseup", function() {

  let preCaretPos = document.activeElement.id ? getCrsrPos(document.activeElement) : false; // [NOTE] when implementing into actual editor, additional id checks will need to be made (to ensure it is a valid vertex field)
  let preVertex = document.activeElement.id || false; // [NOTE]

  // Update cursor position in Firebase (after event finishes):
  setTimeout(function() {

    // Ensure that a valid vertex was clicked on:
    if (document.activeElement.id && !document.activeElement.classList.contains("link-creator-element")) { // [NOTE] when implementing into actual editor, additional id checks will need to be made (to ensure it is a valid vertex field)

      let caretPos = document.activeElement.id ? getCrsrPos(document.activeElement) : false; // [NOTE]

      if (preCaretPos.start !== caretPos.start || preCaretPos.end !== caretPos.end || preVertex !== document.activeElement.id) {
        actvStyles = getActvStyles(document.activeElement);
        actvtBtns();
      }

      set(ref(db, `users/${uid}/cursor`), getCrsrPos(document.activeElement));
      set(ref(db, `users/${uid}/changed`), getCurrentTime());
      set(ref(db, `users/${uid}/status`), "active");
    }
  }, 0);

});

function setText(el, text, pos, ignoreCursor, classes, href) {

  // There was a text selection that is being overridden; remove the text being overridden:
  if (pos.start !== pos.end) {

    // Use the classes (for styling) and href of the first element if text is being overridden:
    classes = classes ? classes : (el.childNodes[pos.start] && el.childNodes[pos.start].classList) ? [...el.childNodes[pos.start].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];
    href = el.childNodes[pos.start] ? (el.childNodes[pos.start].dataset ? ((pos.start >= 0 && el.childNodes[pos.start].dataset.href !== undefined) ? ` data-href="${el.childNodes[pos.start].dataset.href}"` : "") : "" /* < Element is a text DOM element */) : "";

    // Remove the text being overridden:
    for (let i = pos.end - 1; i >= pos.start; i--) {
      if (el.childNodes[i])
        el.childNodes[i].remove();
    }
  }

  // If no text is to be inserted, we're done here:
  if (text.length === 0)
    return;

  // If the text to be inserted contains multiple characters, use a recursive call to add them one at a time (in order):
  if (text.length > 1) {
    for (let i = 0; i < text.length; i++) {
      setText(el, text[i], { start: pos.start + i, end: pos.start + i }, true, classes, href);
    }

    if (!ignoreCursor)
      setCrsrPos(el, { start: pos.start + text.length, end: pos.start + text.length });

    return;
  }

  // Only 1 character is to be added; get the classes (for styling) and the href:
  let classList = classes ? classes : actvStyles;
  if (el.childNodes[pos.start - 1] && el.childNodes[pos.start] && el.childNodes[pos.start - 1].classList && el.childNodes[pos.start - 1].classList.contains("link") && el.childNodes[pos.start - 1].dataset.href === el.childNodes[pos.start].dataset.href)
    classList.push("link");

  // Add cursor selection classes if text is being added in the middle of another user's selection:
  if (el.childNodes[pos.start - 1] && el.childNodes[pos.start - 1].classList && el.childNodes[pos.start] && el.childNodes[pos.start].classList) {
    let cursorSelectionsBefore = [...el.childNodes[pos.start - 1].classList].filter(cl => cl.indexOf("cursor-selection") !== -1);
    let cursorSelectionsAfter = [...el.childNodes[pos.start].classList].filter(cl => cl.indexOf("cursor-selection") !== -1);

    for (let i = 0; i < cursorSelectionsBefore.length; i++) {
      if (cursorSelectionsAfter.indexOf(cursorSelectionsBefore[i]) !== -1)
        classList.push(cursorSelectionsBefore[i]);
    }
  }
  let classText = classList.length > 0 ? ` class="${classList.join(" ")}"`: "";

  let hrefData = href ? href : (el.childNodes[pos.start - 1] && el.childNodes[pos.start] ? ((pos.start - 1 >= 0 && el.childNodes[pos.start - 1].dataset.href !== undefined && el.childNodes[pos.start - 1].dataset.href === el.childNodes[pos.start].dataset.href) ? ` data-href="${el.childNodes[pos.start - 1].dataset.href}"` : "") : "");

  // Append the element to the editor:
  let span = document.createElement("div");
  span.innerHTML = `<span${classText}${hrefData}>${text}</span>`;
  if (pos === el.textContent.length) {
    el.appendChild(span.childNodes[0]);
  } else {
    el.insertBefore(span.childNodes[0], el.childNodes[pos.start]);
  }

  // Set the caret position (if requested):
  if (!ignoreCursor)
    setCrsrPos(el, { start: pos.start + 1, end: pos.start + 1 });

}

function setCrsrs(users) {

  // Check if a user has disconnected:
  for (let u in userCache) {

    // This user no longer exists in Firebase; user has disconnected:
    if (!users[u]) {

      // Delete the user from the cache:
      delete userCache[u];

      // Remove the user's cursor:
      while (document.getElementsByClassName(`cursor_${u}`).length > 0)
        document.getElementsByClassName(`cursor_${u}`)[0].classList.remove(`cursor_${u}`);

      while (document.getElementsByClassName(`cursor-selection_${u}`).length > 0)
        document.getElementsByClassName(`cursor-selection_${u}`)[0].classList.remove(`cursor-selection_${u}`);
    }
  }

  // Check if a user has joined:
  for (let u in users) {

    // This user did not previously exist in cache; this is a new user:
    if (!userCache[u]) {

      userCache[u] = users[u];
      userCache[u].newUser = true;

      // Set cursor styles:
      applyCSSStyle(`cursor_${u}`, `border-left: 2px solid ${stringToColor(u)}; margin-left: -2px; animation: blink 1.06s steps(2, start) infinite; -webkit-animation: blink 1.06s steps(2, start) infinite;`);
      applyCSSStyle(`cursor-selection_${u}`, `background-color: ${stringToColor(u)}50;`);
    }
  }

  for (let u in users) {

    // Skip self:
    if (u === uid)
      continue;

    // Check if the user's cursor has not moved; if so, there is no need to update it:
    let currCrsrPos = users[u].vertex ? [...document.getElementById(users[u].vertex).childNodes].indexOf(document.getElementsByClassName(`cursor_${u}`)[0]) : false;

    // Update the cursor if the user is a new user, they have made a change of some sort (including have moved their cursor), or if the cursor is in the wrong position:
    if (!userCache[u].newUser && JSON.stringify(users[u].changed) === JSON.stringify(userCache[u].changed) && ((!users[u].vertex || !users[u].cursor) || (users[u].cursor.start !== users[u].cursor.end) || (!users[uid] || users[u].updated < lastUpdated || users[u].cursor.start === currCrsrPos))) {
      userCache[u] = users[u];
      continue;
    }

    // Update the user cache:
    userCache[u] = users[u];

    // Clear previous cursor/cursor selection:
    while (document.getElementsByClassName(`cursor_${u}`).length > 0)
      document.getElementsByClassName(`cursor_${u}`)[0].classList.remove(`cursor_${u}`);

    while (document.getElementsByClassName(`cursor-selection_${u}`).length > 0)
      document.getElementsByClassName(`cursor-selection_${u}`)[0].classList.remove(`cursor-selection_${u}`);

    // Don't apply cursors if this user is not currently editing a vertex:
    if (!users[u].vertex || !users[u].cursor)
      continue;

    // Add new cursor/cursor selection:
    let nodeSpans = document.getElementById(users[u].vertex).childNodes;

    // User has a cursor but does not have a selection; add cursor:
    if (users[u].cursor.start === users[u].cursor.end) {

      if (nodeSpans[users[u].cursor.start])
        nodeSpans[users[u].cursor.start].classList.add(`cursor_${u}`);

    // User has a selection; add cursor selection:
    } else {

      for (let i = users[u].cursor.start; i < users[u].cursor.end; i++) {
        if (nodeSpans[i])
          nodeSpans[i].classList.add(`cursor-selection_${u}`);
      }

    }
  }

}

function applyCSSStyle(clas, style) {

  let rules = document.styleSheets[0].cssRules;

  // Change the rule if it already exists:
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].selectorText === `.${clas}`) {
      rules[i].style = style;
      return;
    }
  }

  // Insert new rule if it doesn't already exist:
  document.styleSheets[0].insertRule(`.${clas} { ${style} }`, 0);
}

// Styling and Link button event handlers:
document.getElementById("bold").addEventListener("mousedown", function(e) {
  e.preventDefault();

  if (!document.activeElement.id)
    return;

  let crsrPos = getCrsrPos(document.activeElement);
  if (crsrPos.start === crsrPos.end) {
    if (actvStyles.indexOf("bold") === -1) {
      actvStyles.push("bold");
    } else {
      actvStyles.splice(actvStyles.indexOf("bold"), 1);
    }

    actvtBtns();
  } else {
    applySelectedStyle(document.activeElement, "bold");
  }
});
document.getElementById("italic").addEventListener("mousedown", function(e) {
  e.preventDefault();

  if (!document.activeElement.id)
    return;

  let crsrPos = getCrsrPos(document.activeElement);
  if (crsrPos.start === crsrPos.end) {
    if (actvStyles.indexOf("italic") === -1) {
      actvStyles.push("italic");
    } else {
      actvStyles.splice(actvStyles.indexOf("italic"), 1);
    }

    actvtBtns();
  } else {
    applySelectedStyle(document.activeElement, "italic");
  }
});
document.getElementById("underline").addEventListener("mousedown", function(e) {
  e.preventDefault();

  if (!document.activeElement.id)
    return;

  let crsrPos = getCrsrPos(document.activeElement);
  if (crsrPos.start === crsrPos.end) {
    if (actvStyles.indexOf("underline") === -1) {
      actvStyles.push("underline");
    } else {
      actvStyles.splice(actvStyles.indexOf("underline"), 1);
    }

    actvtBtns();
  } else {
    applySelectedStyle(document.activeElement, "underline");
  }
});
document.getElementById("strikethrough").addEventListener("mousedown", function(e) {
  e.preventDefault();

  if (!document.activeElement.id)
    return;

  let crsrPos = getCrsrPos(document.activeElement);
  if (crsrPos.start === crsrPos.end) {
    if (actvStyles.indexOf("strikethrough") === -1) {
      actvStyles.push("strikethrough");
    } else {
      actvStyles.splice(actvStyles.indexOf("strikethrough"), 1);
    }

    actvtBtns();
  } else {
    applySelectedStyle(document.activeElement, "strikethrough");
  }
});
document.getElementById("link").addEventListener("mousedown", function(e) {
  e.preventDefault();

  // Close old link creators:
  while (document.getElementsByClassName("link-creator").length > 0) {
    document.getElementsByClassName("link-creator")[0].remove();
  }
  clrSelection();

  // Can't create a link if no element is selected:
  if (!document.activeElement.id) // [NOTE] update in future for better checks
    return;

  let crsrPos = getCrsrPos(document.activeElement);

  // Open a new link creator if there is a selection:
  if (crsrPos.start !== crsrPos.end)
    createDocLink(document.getElementById("editor"));
});

function applyStyle(el, styles) {

  // Override all styles with the passed in "styles":
  for (let style in styles) {
    for (let i = 0; i < styles[style].length; i++) {
      if (styles[style][i] === "X") {
        applySelectedStyle(el, style, { start: i, end: i + 1 }, true);
      }
    }
  }
}

function applySelectedStyle(el, style, pos, addStyle) {

  let childNodeSpans = el.childNodes;
  let localChanges = pos ? false : true;

  // Get current caret position:
  if (!pos)
    pos = getCrsrPos(el);

  // Check if style needs to be added or removed:
  if (addStyle === undefined) {
    addStyle = false;

    for (let i = pos.start; i < pos.end; i++) {
      if (!childNodeSpans[i].classList.contains(style)) {
        addStyle = true;
        break;
      }
    }
  }

  // If no pos is passed in, assume that this was a local change:
  if (localChanges) {

    // Update the active styling:
    setTimeout(function() {
      if (document.activeElement.id) { // [NOTE]
        actvStyles = getActvStyles(document.activeElement);
        actvtBtns();
      }
    }, 0);

    // Push changes:
    buffer({
      vertex: "editor",
      action: "style",
      contentPre: el.textContent.substring(pos.start, pos.end),
      content: (addStyle ? "" : "-") + style,
      index: {
        start: pos.start,
        end: pos.end
      },
      surrounding: {
        before: el.textContent[pos.start - 1] || false,
        after: (pos.end === el.textContent.length - 1 && el.textContent[pos.end] === "\n") ? false : (el.textContent[pos.end] || false)
      }
    });

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
  }

  // Apply style:
  for (let i = pos.start; i < pos.end; i++) {
    if (addStyle && !childNodeSpans[i].classList.contains(style)) {
      childNodeSpans[i].classList.add(style);
    } else if (!addStyle) {
      childNodeSpans[i].classList.remove(style);
    }
  }
}

function createDocLink(el, link) {

  let childNodeSpans = el.childNodes;
  let crsrPos = getCrsrPos(el);

  // Display that the text is still selected:
  for (let i = crsrPos.start; i < crsrPos.end; i++) {
    childNodeSpans[i].classList.add("selected");
  }
  setTimeout(function() {
    set(ref(db, `users/${uid}/vertex`), el.id);
    set(ref(db, `users/${uid}/cursor`), crsrPos);
  }, 0);

  // Get the position of the selected text on the display:
  let selectionPos = getSelectionPosition(crsrPos);

  // Create the div to insert a link:
  let div = document.createElement("div");
  div.innerHTML = `<div class="link-creator link-creator-element" style="position: absolute; left: calc(${selectionPos.x + selectionPos.w / 2}px - 200px); top: calc(${selectionPos.y + selectionPos.h}px + 20px);">
    <div class="link-creator-input link-creator-element" contenteditable="true">
      ${link || ""}
    </div>
    <div class="link-creator-preview link-creator-element">
      <img src="./resources/icons/editor/preview.svg" class="link-creator-element">
    </div>
    <div class="link-creator-cancel link-creator-element">
      <img src="./resources/icons/close.svg" class="link-creator-element">
    </div>
    <div class="link-creator-confirm link-creator-element">
      <img src="./resources/icons/confirm.svg" class="link-creator-element">
    </div>
  </div>`;

  // Display it to the user:
  document.body.appendChild(div.childNodes[0]); // [NOTE] when implementing into the actual editor, make sure that the link creator is fixed to the editor element itself, so it doesn't move if the page is scrolled

  // Focus the input and add event listeners:
  let createLink = document.getElementsByClassName("link-creator")[document.getElementsByClassName("link-creator").length - 1];

  if (!link)
    createLink.getElementsByClassName("link-creator-input")[0].focus();

  // Clean pasted text:
  createLink.addEventListener("paste", function(e) {
    e.preventDefault();
    let textToPaste = e.clipboardData.getData("text/plain");
    document.execCommand("insertHTML", false, textToPaste);
  });

  // Preview button:
  createLink.getElementsByClassName("link-creator-preview")[0].addEventListener("click", function() {
    window.open(createLink.getElementsByClassName("link-creator-input")[0].textContent.trim(), "_blank");
  });

  // Close button:
  createLink.getElementsByClassName("link-creator-cancel")[0].addEventListener("click", function() {
    setLink(el, el.childNodes[crsrPos.start].dataset.href, crsrPos, false, true);
    createLink.remove();
    clrSelection();
    el.focus();
    setCrsrPos(el, { start: crsrPos.end, end: crsrPos.end });
  });

  // Confirm button:
  createLink.getElementsByClassName("link-creator-confirm")[0].addEventListener("click", function() {
    if (createLink.getElementsByClassName("link-creator-input")[0].textContent.trim() !== "")
      setLink(el, createLink.getElementsByClassName("link-creator-input")[0].textContent.trim(), crsrPos, true, true);
    createLink.remove();
    clrSelection();
    el.focus();
    setCrsrPos(el, { start: crsrPos.end, end: crsrPos.end });
  });

  // Handle enter:
  createLink.getElementsByClassName("link-creator-input")[0].addEventListener("keydown", function(e) {
    if (e.keyCode === 13) {
      e.preventDefault();
      if (createLink.getElementsByClassName("link-creator-input")[0].textContent.trim() !== "")
        setLink(el, createLink.getElementsByClassName("link-creator-input")[0].textContent.trim(), crsrPos, true, true);
      createLink.remove();
      clrSelection();
      el.focus();
      setCrsrPos(el, { start: crsrPos.end, end: crsrPos.end });
    }
  });
}

function clrSelection() {

  // Clear all elements with the "selected" class:
  while (document.getElementsByClassName("selected").length > 0)
    document.getElementsByClassName("selected")[0].classList.remove("selected");
}

function overrideLinks(el, links) {

  // Override all links with the passed in "links":
  for (let i in links) {
    if (links[i]) {
      setLink(el, links[i], { start: Number(i), end: Number(i) + 1 }, true, false);
    }
  }
}

function setLink(el, link, pos, addLink, localChange) {

  let childNodeSpans = el.childNodes;

  // Get current caret position:
  if (!pos)
    pos = getCrsrPos(el);

  // If no pos is passed in, assume that this was a local change:
  if (localChange) {

    // Push changes:
    buffer({
      vertex: "editor",
      action: addLink ? "link" : "-link",
      contentPre: el.textContent.substring(pos.start, pos.end),
      content: link || "",
      index: {
        start: pos.start,
        end: pos.end
      },
      surrounding: {
        before: el.textContent[pos.start - 1] || false,
        after: (pos.end === el.textContent.length - 1 && el.textContent[pos.end] === "\n") ? false : (el.textContent[pos.end] || false)
      }
    });

    lastKeyPress = getCurrentTime();
    pushChanges(lastKeyPress);
  }

  // Apply link:
  for (let i = pos.start; i < pos.end; i++) {
    if (addLink) {
      childNodeSpans[i].classList.add("link");
      childNodeSpans[i].dataset.href = link;
    } else {
      childNodeSpans[i].classList.remove("link");
      childNodeSpans[i].removeAttribute("data-href");
    }
  }
}

function undoOP(c, buf) {

  // Create and return a change that will undo whatever the passed in change changed:
  switch(c.action) {
    case "type":
      return {
        vertex: c.vertex,
        uid: uid,
        timestamp: getCurrentTime(),
        action: "delete",
        contentPre: c.content,
        undo: buf,
        index: {
          start: c.index.start,
          end: c.index.end
        },
        surrounding: {
          before: document.getElementById(c.vertex).textContent[c.index.start - 1] || false,
          after: (c.index.start + 1 === document.getElementById(c.vertex).textContent.length - 1 && document.getElementById(c.vertex).textContent[c.index.start + 1] === "\n") ? false : (document.getElementById(c.vertex).textContent[c.index.start + 1] || false)
        }
      };
    break;
    case "delete":
      return {
        vertex: c.vertex,
        uid: uid,
        timestamp: getCurrentTime(),
        action: "type",
        content: c.contentPre,
        undo: buf,
        index: {
          start: c.index.start,
          end: c.index.end
        },
        surrounding: {
          before: document.getElementById(c.vertex).textContent[c.index.start - 1] || false, // The first part of this conditional is to ignore the last "\n" that HTML sometimes autofills (for whatever reason):
          after: (c.index.start === document.getElementById(c.vertex).textContent.length - 1 && document.getElementById(c.vertex).textContent[c.index.start] === "\n") ? false : (document.getElementById(c.vertex).textContent[c.index.start] || false)
        }
      };
    break;
    case "insert":
      return {
        vertex: c.vertex,
        uid: uid,
        timestamp: getCurrentTime(),
        action: "replace",
        contentPre: c.content,
        content: "",
        undo: buf,
        index: {
          start: c.index.start,
          end: c.index.end + c.content.length
        },
        surrounding: {
          before: document.getElementById(c.vertex).textContent[c.index.start - 1] || false,
          after: (c.index.start + c.content.length === document.getElementById(c.vertex).textContent.length - 1 && document.getElementById(c.vertex).textContent[c.index.start + c.content.length] === "\n") ? false : (document.getElementById(c.vertex).textContent[c.index.start + c.content.length] || false)
        }
      };
    break;
    case "replace":
      return {
        vertex: c.vertex,
        uid: uid,
        timestamp: getCurrentTime(),
        action: "replace",
        contentPre: c.content,
        content: c.contentPre,
        undo: buf,
        index: {
          start: c.index.start,
          end: c.index.start + c.content.length
        },
        surrounding: {
          before: document.getElementById(c.vertex).textContent[c.index.start - 1] || false,
          after: (c.index.start + c.content.length === document.getElementById(c.vertex).textContent.length - 1 && document.getElementById(c.vertex).textContent[c.index.start + c.content.length] === "\n") ? false : (document.getElementById(c.vertex).textContent[c.index.start + c.content.length] || false)
        }
      };
    break;
    case "style":
      return {
        vertex: c.vertex,
        uid: uid,
        timestamp: getCurrentTime(),
        action: "style",
        contentPre: c.contentPre,
        content: (c.content[0] === "-" ? c.content.substring(1) : ("-" + c.content)),
        undo: buf,
        index: {
          start: c.index.start,
          end: c.index.end
        },
        surrounding: {
          before: document.getElementById(c.vertex).textContent[c.index.start - 1] || false,
          after: (c.index.end === document.getElementById(c.vertex).textContent.length - 1 && document.getElementById(c.vertex).textContent[c.index.end] === "\n") ? false : (document.getElementById(c.vertex).textContent[c.index.end] || false)
        }
      };
    break;
    case "-link":
    case "link":
      return {
        vertex: c.vertex,
        uid: uid,
        timestamp: getCurrentTime(),
        action: c.action[0] === "-" ? "link" : "-link",
        contentPre: c.contentPre,
        content: c.content,
        undo: buf,
        index: {
          start: c.index.start,
          end: c.index.end
        },
        surrounding: {
          before: document.getElementById(c.vertex).textContent[c.index.start - 1] || false,
          after: (c.index.end === document.getElementById(c.vertex).textContent.length - 1 && document.getElementById(c.vertex).textContent[c.index.end] === "\n") ? false : (document.getElementById(c.vertex).textContent[c.index.end] || false)
        }
      };
    break;
  }
}

function executeUndo() {

  // Undo the change:
  buffer(undoOP(stack.undo[stack.undo.length - 1], true), true);
  applyChngs(undoOP(stack.undo[stack.undo.length - 1]), true);

  // Push the undone change to the redo stack:
  stack.redo.push(stack.undo[stack.undo.length - 1]);

  // Clear the undone change from the undo stack:
  stack.undo.pop();

  // Push changes to Firebase:
  lastKeyPress = getCurrentTime();
  pushChanges(lastKeyPress);
}

function redoOP(c, buf) {

  if (!buf)
    return c;

  // Update the UID, the timestamp, and set the "redo" key to true when sending out redo changes:
  c.uid = uid;
  c.timestamp = getCurrentTime();
  c.redo = true;
  return c;
}

function executeRedo() {

  // Redo the change:
  buffer(redoOP(stack.redo[stack.redo.length - 1], true), true);
  applyChngs(stack.redo[stack.redo.length - 1], true);

  // Push the undone change to the redo stack:
  stack.undo.push(stack.redo[stack.redo.length - 1]);

  // Clear the undone change from the undo stack:
  stack.redo.pop();

  // Push changes to Firebase:
  lastKeyPress = getCurrentTime();
  pushChanges(lastKeyPress);
}

async function pushChanges(t) {

  // Check for changes on the server side:
  let changesObj = await acquireData("changes", function(err) { console.error(err); });

  // This will check for changes and apply them if found; otherwise, the function will return false:
  if (!checkChanges(changesObj, t)) {

    // No changes to handle; push pending changes:
    let changedVertexes = [];

    if (document.activeElement.id) // [NOTE] when implementing into actual editor, verify that this is an actual vertex
      changedVertexes.push(document.activeElement.id);

    while (pending.length > 0) {

      if (changedVertexes.indexOf(pending[0].vertex) === -1)
        changedVertexes.push(pending[0].vertex);

      set(push(child(ref(db), "changes")), pending.splice(0, 1)[0]);
    }

    // Update the stored content and the user changed time:
    setTimeout(function() {

      // Ensure that no changes have been made during the 100ms delay:
      if (getCurrentTime() - lastChange < 100)
        return;

      for (let i = 0; i < changedVertexes.length; i++) {
        set(ref(db, `vertexes/${changedVertexes[i]}/content`), {
          text: document.getElementById(changedVertexes[i]).textContent + (document.getElementById(changedVertexes[i]).textContent[document.getElementById(changedVertexes[i]).textContent.length - 1] !== "\n" ? "\n" : ""),
          style: {
            bold: acquireMetaTag(document.getElementById(changedVertexes[i]), "bold"),
            italic: acquireMetaTag(document.getElementById(changedVertexes[i]), "italic"),
            underline: acquireMetaTag(document.getElementById(changedVertexes[i]), "underline"),
            strikethrough: acquireMetaTag(document.getElementById(changedVertexes[i]), "strikethrough")
          },
          links: acquireMetaTag(document.getElementById(changedVertexes[i]), "links"),
          updated: getCurrentTime(),
          uid: uid
        });
      }
    }, 100);
    setTimeout(async function() {
      set(ref(db, `users/${uid}/changed`), getCurrentTime());
      set(ref(db, `users/${uid}/status`), "active");
    }, 0);
    setTimeout(async function() {

      // Update the cursor positions:
      let userData = (await acquireData("users", function(err) { console.error(err); })) || {};
      setCrsrs(userData);
    }, 250);
  }

}

function acquireMetaTag(el, type) {
  switch(type) {
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
      return [...el.childNodes].map(elm => elm.classList.contains(type) ? "X" : "_").slice(0, -1).join("");
    break;
    case "links":
      let links = [...el.childNodes].map(elm => elm.dataset.href || "").slice(0, -1);
      let newLinks = {};

      for (let i = 0; i < links.length; i++) {
        if (links[i])
          newLinks[i] = links[i]
      }

      return newLinks;
    break;
  }
}

function checkChanges(changesObj, t) {

  // Orgainze the changes:
  let changes = [];
  for (let i in changesObj) {

    // Check if this change has already been applied:
    if (applied.indexOf(i) !== -1)
      continue;

    let changeToPush = copyObj(changesObj[i]);
    changeToPush.key = i;

    // Otherwise, we will apply this change:
    changes.push(changeToPush);
  }

  // No changes to be made; return:
  if (changes.length === 0)
    return false;

  // Otherwise, we have at least one change to handle:
  quicksort(changes, 0, changes.length - 1, "timestamp");

  // Apply changes:
  for (let i = 0; i < changes.length; i++) {
    if (changes[i].uid !== uid) {
      applyChngs(changes[i]);
    }
    applied.push(changes[i].key);
  }

  lastChange = getCurrentTime();
  lastUpdated = changes[changes.length - 1].timestamp;

  // After changes have been applied, update the last updated timestamp for this user and check to see if the change can be removed from Firebase:
  setTimeout(async function() {
    await set(ref(db, `users/${uid}/updated`), changes[changes.length - 1].timestamp);

    let users = await acquireData("users", function(err) { console.error(err); });
    let allChnges = await acquireData("changes", function(err) { console.error(err); });

    // Determine the most recent change for each vertex:
    let lastChngs = {};
    for (let change in allChnges) {
      lastChngs[allChnges[change].vertex] = change;
    }

    // Remove changes if all clients have applied them:
    let updatedChngs;
    for (let change in allChnges) {
      updatedChngs = true;
      for (let i in users) {
        if (users[i].updated < allChnges[change].timestamp) {
          updatedChngs = false;
          break;
        }
      }

      // If all clients have already applied this change, remove it and update the stored content:
      if (updatedChngs) {
        remove(ref(db, `changes/${change}`));

        // If this is the last change for the currently active vertex, update the content in Firebase:
        if (change === lastChngs[allChnges[change].vertex] && allChnges[change].vertex === activeVertex) {
          setTimeout(function() {

            // Ensure that no changes have been made during the 100ms delay:
            if (getCurrentTime() - lastChange < 100)
              return;

            // Update the content in Firebase:
            set(ref(db, `vertexes/${allChnges[change].vertex}/content`), {
              text: document.getElementById(allChnges[change].vertex).textContent + (document.getElementById(allChnges[change].vertex).textContent[document.getElementById(allChnges[change].vertex).textContent.length - 1] !== "\n" ? "\n" : ""),
              style: {
                bold: acquireMetaTag(document.getElementById(allChnges[change].vertex), "bold"),
                italic: acquireMetaTag(document.getElementById(allChnges[change].vertex), "italic"),
                underline: acquireMetaTag(document.getElementById(allChnges[change].vertex), "underline"),
                strikethrough: acquireMetaTag(document.getElementById(allChnges[change].vertex), "strikethrough")
              },
              links: acquireMetaTag(document.getElementById(allChnges[change].vertex), "links"),
              updated: getCurrentTime(),
              uid: uid
            });
          }, 100);
        }
      }
    }
  }, 0);

  // If no pending changes have been made since the last keypress, try again:
  if (t && t === lastKeyPress) {
    pushChanges();
  }

  return true;

}

function applyChngs(c, isUndoRedo) {

  // Store the caret position and text content of the editor:
  let crsrPos = getCrsrPos(c.vertex);
  let text = document.getElementById(c.vertex).textContent;

  // Remove the "\n" that is always present, but not actually able to be edited:
  text = (text[text.length - 1] === "\n") ? (text.substring(0, text.length - 1)) : text;

  let transform = getTransformVals(c, text);

  // Apply the trasnsform:
  c.index.start += transform;
  c.index.end += transform;

  if (!isUndoRedo) {

    // Apply undo/redo to local stack:
    if (c.undo) {
      if (stack.undo.length > 0) {
        stack.redo.push(stack.undo[stack.undo.length - 1]);
        stack.undo.pop();
      }
    } else if (c.redo) {
      if (stack.redo.length > 0) {
        stack.undo.push(stack.redo[stack.redo.length - 1]);
        stack.redo.pop();
      }

    // Otherwise, this change was not an undo/redo itself; add this change to the local stack for future use:
    } else {
      stack.undo.push(c);
      stack.redo = [];
    }
  }

  // Transform the change based on the pending changes:
  for (let i = 0; i < pending.length; i++) {
    // The pending text comes before the index where the text is to be replaced; therefore, move the text to be inserted over:
    if (pending[i].action === "type" && pending[i].index <= c.index.start) {
      c.index.start++;
    }
    if (pending[i].action === "type" && pending[i].index <= c.index.end) {
      c.index.end++;
    }
    if (pending[i].action === "delete" && pending[i].index <= c.index.start) {
      c.index.start--;
    }
    if (pending[i].action === "delete" && pending[i].index <= c.index.end) {
      c.index.end--;
    }
    if (pending[i].action === "insert" && pending[i].index <= c.index.start) {
      c.index.start += pending[i].content.length;
    }
    if (pending[i].action === "insert" && pending[i].index <= c.index.end) {
      c.index.end += pending[i].content.length;
    }
    // Replacing could be implemented here, but it's quite the hassle
  }

  switch(c.action) {
    case "type":

      // Transform the pending text based on this change:
      for (let i = 0; i < pending.length; i++) {
        // The text to be typed comes before the pending text; therefore, move the pending text over:
        if (pending[i].action === "replace") {
          if (c.index.start <= pending[i].index.start) {
            pending[i].index.start++;
            pending[i].index.end++;
          }
          continue;
        }
        if (c.index.start < pending[i].index) {
          pending[i].index++;
        }
      }

      // Type the text:
      setText(document.getElementById(c.vertex), c.content, { start: c.index.start, end: c.index.start }, true, c.style);
    break;
    case "delete":

      // Transform the pending text based on this change:
      for (let i = 0; i < pending.length; i++) {
        // The text to be deleted comes before the pending text; therefore, move the pending text over:
        if (pending[i].action === "replace") {
          if (c.index.start <= pending[i].index.start) {
            pending[i].index.start--;
            pending[i].index.end--;
          }
          continue;
        }
        if (c.index.start < pending[i].index) {
          pending[i].index--;
        }
      }

      // Delete the text:
      setText(document.getElementById(c.vertex), "", { start: c.index.start, end: c.index.start + 1 }, true, c.style);
    break;
    case "insert":

      // Transform the pending text based on this change:
      for (let i = 0; i < pending.length; i++) {
        // The text to be inserted comes before the pending text; therefore, move the pending text over:
        if (pending[i].action === "replace") {
          if (c.index.start <= pending[i].index.start) {
            pending[i].index.start += c.content.length;
            pending[i].index.end += c.content.length;
          }
          continue;
        }
        if (c.index.start < pending[i].index) {
          pending[i].index += c.content.length;
        }
      }

      // Insert the text:
      setText(document.getElementById(c.vertex), c.content, { start: c.index.start, end: c.index.start }, true, c.style);
    break;
    case "replace":

      // Dealing with pending text could be implemented here, but it's a hassle and "getTransform" will usually handle it on the other clients anyway

      // Replace the text:
      setText(document.getElementById(c.vertex), c.content, { start: c.index.start, end: c.index.end }, true, c.style);
    break;
    case "style":

      // Style the text:
      let addStyle = c.content[0] === "-" ? false : true;
      let style = addStyle ? c.content : c.content.substring(1);
      applySelectedStyle(document.getElementById(c.vertex), style, { start: c.index.start, end: c.index.end }, addStyle);
    break;
    case "-link":
    case "link":

      // Link the text:
      let addLink = c.action[0] === "-" ? false : true;
      setLink(document.getElementById(c.vertex), c.content, { start: c.index.start, end: c.index.end }, addLink, false);
    break;
  }

  // Update cursor position in Firebase and get active styles (after event finishes):
  setTimeout(function() {

    if (document.activeElement.id) { // [NOTE]
      actvStyles = getActvStyles(document.activeElement);
      actvtBtns();
    }

    if (!document.activeElement.classList.contains("link-creator-element"))
      set(ref(db, `users/${uid}/cursor`), getCrsrPos(document.getElementById(c.vertex)));
  }, 0);
}

function getTransformVals(c, t) {

  // Setup weights:
  let weights = { before: 1, at: c.contentPre !== undefined ? 3 : 0, after: 1 };

  // Setup the FitScores object:
  let fitScores = {
    before: {
      scores: [],
      max: -1
    },
    at: 0,
    after: {
      scores: [],
      max: -1
    },
    transform: 0
  };

  // Check to see how good of a fit the intended position is:
  fitScores.at = getMyFitScores(c, t, 0, weights);

  // Check how good of a fit the positions before and after the intended position are:
  let reach = t.length;
  for (let i = 1; i < reach + 1; i++) {
    fitScores.before.scores.push(getMyFitScores(c, t, -i, weights));
    fitScores.after.scores.push(getMyFitScores(c, t, i, weights));
  }

  // Determine the ideal scores for moving the text to be inserted before / after:
  fitScores.before.max = Math.max(...fitScores.before.scores);
  fitScores.after.max = Math.max(...fitScores.after.scores);

  // Get the transform (if moving the character achieves a higher score than where it is currently placed):
  if (fitScores.at !== (weights.before + weights.at + weights.after) && (fitScores.before.max > fitScores.at || fitScores.after.max > fitScores.at)) {
    
    if (fitScores.before.max > fitScores.after.max || fitScores.before.max === fitScores.after.max && fitScores.before.scores.indexOf(fitScores.before.max) < fitScores.after.scores.indexOf(fitScores.after.max))
      fitScores.transform = -fitScores.before.scores.indexOf(fitScores.before.max) - 1; // Subtract 1 since arrays start at 0

    if (fitScores.before.max < fitScores.after.max || fitScores.before.max === fitScores.after.max && fitScores.after.scores.indexOf(fitScores.after.max) <= fitScores.before.scores.indexOf(fitScores.before.max))
      fitScores.transform = fitScores.after.scores.indexOf(fitScores.after.max) + 1; // Add 1 since arrays start at 0
  }

  return fitScores.transform;

}

function getMyFitScores(c, t, offset, weights) {

  // Index is out of range (note that characters can be inserted anywhere from 0 to t.length, hence why this is > t.length and not >= t.length):
  if (c.index.start + offset < 0 || c.index.end + offset > t.length)
    return 0;

  // Calculate the FitScore at the provided index (with offset included):
  let fitScore = {
    // Check the fit before the current offset index:
    before: (ifFit(t, c.index.start + offset - 1, c.surrounding.before) ? weights.before : 0),
    // Check the fit of the content at/between the curent indexes (assuming there is content to check):
    at: (c.contentPre !== undefined && ifFit(t, { start: c.index.start + offset, end: c.index.end + offset }, c.contentPre) ? weights.at : 0),
    // Check the fit after the current offset index (note that we only need to add 1 to the offset if the action is "delete", or something similar):
    after: (ifFit(t, c.index.end + offset + ((c.contentPre !== undefined && c.index.start === c.index.end && c.contentPre !== "") ? 1 : 0), c.surrounding.after) ? weights.after : 0)
  };

  // Return the calculated FitScore:
  return fitScore.before + fitScore.at + fitScore.after;
}

function ifFit(t, i, compTo) {

  // Handle cases where only one index is being checked:
  if (i.start === undefined)
    return ((i >= 0 && i < t.length) ? t[i] : false) === compTo;

  // The start and end indexes are the same, and "compTo" is empty; this happens when "contentPre" in "replace" is empty; this should always return true:
  if (i.start === i.end && compTo === "")
    return true;

  // The start and end indexes are the same; compare the character at "i.start" to "compTo":
  if (i.start === i.end)
    return ((i.start >= 0 && i.start < t.length) ? t[i.start] : false) === compTo;

  // Handle cases where a group of text (multiple indexes) are being checked:
  // Grab the entire string of characters from "i.start" to "i.end" and compare them to "compTo":
  return t.substring(i.start, i.end) === compTo;
}

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

function getCrsrPos(el) {

  // If no element is focused, return:
  if (el !== document.activeElement)
    return false;

  // Get the current range:
  let range = window.getSelection().getRangeAt(0);

  // Find the starting position of the range:
  let caretRangeStart = range.cloneRange();
  caretRangeStart.selectNodeContents(el);
  caretRangeStart.setEnd(range.startContainer, range.startOffset);

  // Find the ending position of the range:
  let caretRangeEnd = range.cloneRange();
  caretRangeEnd.selectNodeContents(el);
  caretRangeEnd.setEnd(range.endContainer, range.endOffset);

  // Return the position data:
  return {
    start: caretRangeStart.toString().length,
    end: caretRangeEnd.toString().length
  };

}

function setCrsrPos(el, pos) {

  // If the element is not the currently focused element, ignore this attempt to set the caret position:
  if (el !== document.activeElement)
    return;

  // Create a new selection range:
  let range = document.createRange();
  let sel = window.getSelection();

  // Set the start and end of the selection range:
  range.setStart(el.childNodes[Math.min(pos.start, el.textContent.length - 1)], pos.start === el.textContent.length ? 1 : 0);
  range.setEnd(el.childNodes[Math.min(pos.end, el.textContent.length - 1)], pos.end === el.textContent.length ? 1 : 0);

  // Apple the selection range:
  sel.removeAllRanges();
  sel.addRange(range);

}

function getSelectionPosition(pos) {

  if (!document.activeElement)
    return;

  // Get the spans:
  let spans = document.activeElement.childNodes;
  let rect;

  // Determine the bounding box of all of the spans:
  let selectionPos = {
    x: {
      min: Infinity,
      max: 0
    },
    y: {
      min: Infinity,
      max: 0
    }
  };

  // Handle if only 1 character is selected:
  if (pos.start === pos.end) {
    return {
      x: rect.left,
      y: rect.top,
      w: 0,
      h: rect.bottom - rect.top
    };
  }

  for (let i = Math.max(pos.start, 0); i < Math.min(pos.end, spans.length); i++) {

    rect = spans[i].getBoundingClientRect();

    selectionPos.x.min = Math.min(selectionPos.x.min, rect.left);
    selectionPos.x.max = Math.max(selectionPos.x.max, rect.right);
    selectionPos.y.min = Math.min(selectionPos.y.min, rect.top);
    selectionPos.y.max = Math.max(selectionPos.y.max, rect.bottom);
  }

  // Return said bounding box:
  return {
    x: selectionPos.x.min,
    y: selectionPos.y.min,
    w: selectionPos.x.max - selectionPos.x.min,
    h: selectionPos.y.max - selectionPos.y.min
  };

}

function getCurrentTime() {
  return Date.now();
}

function stringToColor(str) {

  // Start t on 1:
  let t = 1;
  for (let i = 0; i < str.length; i++) {
    // Vary t based on the contents of the string so each string is (mostly) unique:
    t += 1;
    t *= str.charCodeAt(i);
    t %= 16777216;
  }

  // Return the color (pad with 4's if not long enough):

  let hex = `#${t.toString(16).padStart(6, "4")}`;

  // Hex values starting with "D" (char code = 100) or higher are too bright:
  for (let i = 1; i < hex.length; i += 2) {
    if (hex.charCodeAt(i) >= 100) {
      hex = hex.substring(0, i) + String.fromCharCode(hex.charCodeAt(i) - 3) + hex.substring(i + 1);
    }
  }
  return hex;
}

function partition(arr, lo, hi, by) {
  let pivot = (by ? arr[hi][by] : arr[hi]);
  let i = lo;
  for (let j = lo; j < hi; j++) {
    if ((by ? arr[j][by] : arr[j]) < pivot) {
      if (i !== j) {
        let t = arr[j];
        arr[j] = arr[i];
        arr[i] = t;
      }
      i++;
    }
  }
  let t = arr[hi];
  arr[hi] = arr[i];
  arr[i] = t;
  return i;
}
function quicksort(arr, lo, hi, by) {
  if (lo < hi) {
    let p = partition(arr, lo, hi, by);
    quicksort(arr, lo, p - 1, by);
    quicksort(arr, p + 1, hi, by);
  }
}

function copyObj(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function throttled(callback, delay) {

  let runCallback = false;
  let wait = false;
  let timeout = () => {
    if (!runCallback) {
      wait = false;
    } else {
      callback();
      runCallback = false;
      setTimeout(timeout, delay);
    }
  };

  return () => {
    if (wait) {
      runCallback = true;
      return;
    }

    callback();
    wait = true;

    setTimeout(timeout, delay);
  };
}

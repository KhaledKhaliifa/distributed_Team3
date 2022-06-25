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
function getActvStyles(el) {

  let caretPos = getCrsrPos(el);

  // Determine what the current active styles should be:
  // No text is selected; get the style of the character before:
  if (caretPos.start === caretPos.end) {
    return (el.childNodes[caretPos.start - 1] && el.childNodes[caretPos.start - 1].classList) ? [...el.childNodes[caretPos.start - 1].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];

  // Text is being selected; get the styles that apply to all characters in the selection:
  } else {

    // Get the styles of the first character in the selection:
    let styles = (el.childNodes[caretPos.start] && el.childNodes[caretPos.start].classList) ? [...el.childNodes[caretPos.start].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];

    // Remove the style if it doesn't apply to all of the characters in the selection:
    for (let i = caretPos.start + 1; i < caretPos.end; i++) {
      let indexedStyles = (el.childNodes[i] && el.childNodes[i].classList) ? [...el.childNodes[i].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];
      styles = styles.filter(cl => indexedStyles.indexOf(cl) !== -1);
    }
    return styles;
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

      // Handle Ctrl + Backspace / Delete:
      } else {

        // Determine what index to delete up to:
        let breakCharacters = " `~!@#$%^&*()-_=+[{]}\\|;:'\",<.>/?\n".split("");
        let initialIndex = crsrPos.start + (this.textContent[crsrPos.start + (e.keyCode === 8 ? -1 : 0)] === " " ? (e.keyCode === 8 ? -2 : 2) : (e.keyCode === 8 ? -1 : 1));
        let i = initialIndex;
        while (i > 0 && i < this.textContent.length - 1 && (breakCharacters.indexOf(this.textContent[i + (e.keyCode === 8 ? -1 : 0)]) === -1 && breakCharacters.indexOf(this.textContent[i + (e.keyCode === 8 ? 0 : -1)]) === -1 || breakCharacters.indexOf(this.textContent[i + (e.keyCode === 8 ? 0 : -1)]) !== -1 && breakCharacters.indexOf(this.textContent[i + (e.keyCode === 8 ? -1 : 0)]) !== -1)) {
          i += (e.keyCode === 8 ? -1 : 1);
        }

        // Update active styles:
        actvStyles = (this.childNodes[i] && this.childNodes[i].classList) ? [...this.childNodes[i].classList].filter(cl => (cl.indexOf("cursor") === -1 && cl.indexOf("link") === -1 && cl.indexOf("selected") === -1)) : [];
        actvtBtns();

        let start = Math.min(crsrPos.start, i);
        let end = Math.max(crsrPos.start, i);

        buffer({
          vertex: "editor",
          action: "replace",
          contentPre: this.textContent.substring(start, end),
          content: "",
          index: {
            start: start,
            end: end
          },
          surrounding: {
            before: this.textContent[start - 1] || false,
            after: (end === this.textContent.length - 1 && this.textContent[end] === "\n") ? false : (this.textContent[end] || false)
          }
        });

        lastKeyPress = getCurrentTime();
        pushChanges(lastKeyPress);

        setText(this, "", { start: start, end: end });

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

function getCurrentTime() {
  return Date.now();
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

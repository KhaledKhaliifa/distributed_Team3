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
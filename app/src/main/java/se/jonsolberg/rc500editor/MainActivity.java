/*
 * RC-500 Editor for Android
 * Copyright (C) 2026 Jon Solberg
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version. See LICENSE.
 */
package se.jonsolberg.rc500editor;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiInputPort;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.locks.LockSupport;

/**
 * Hosts the bundled editor (assets = the web version) in a WebView and gives it access to the
 * pedal's USB port through a small JavaScript bridge (window.RC500Native, see web/js/platform.js):
 * USB MIDI via android.media.midi and the RC-500's USB drive via the Storage Access Framework.
 */
public class MainActivity extends Activity {

    private static final int REQ_FOLDER = 1, REQ_SAVE = 2, REQ_FILE = 3;
    private static final String PREFS = "rc500", KEY_TREE = "tree";

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());

    // Storage
    private Uri tree;                                  // picked folder (persisted permission)
    private final Map<String, String> docIds = new HashMap<>(); // path -> document id cache
    private final Map<String, Out> writers = new HashMap<>();
    private int nextToken = 1;
    private String readPath; private InputStream readStream; private long readPos;
    private int pendingFolderId, pendingSaveId;
    private ValueCallback<Uri[]> fileCallback;

    // MIDI
    private MidiManager midiManager;
    private MidiDevice midiDevice;
    private MidiInputPort midiIn;   // we send into the pedal's input port
    private MidiOutputPort midiOut; // and listen on its output port
    private MidiManager.DeviceCallback deviceCallback;

    // MIDI clock to the pedal
    private volatile double clockBpm = 120;
    private volatile boolean clockRun;
    private Thread clockThread;

    private static class Out {
        final ParcelFileDescriptor pfd; final OutputStream os;
        Out(ParcelFileDescriptor pfd) { this.pfd = pfd; this.os = new FileOutputStream(pfd.getFileDescriptor()); }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        setContentView(web);
        if (savedInstanceState == null) UpdateChecker.start(this);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowContentAccess(false);
        s.setBlockNetworkLoads(true);  // the editor is fully bundled; nothing comes from the network
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("http".equals(u.getScheme()) || "https".equals(u.getScheme())) {
                    // Links (GitHub, Ko-fi, …) open in the phone's browser.
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                    return true;
                }
                return !"file".equals(u.getScheme());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                boolean audio = false;
                for (String t : types) if (t.startsWith("audio") || t.endsWith(".wav") || t.endsWith(".mp3")) audio = true;
                i.setType(audio ? "audio/*" : "*/*");
                try { startActivityForResult(i, REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "RC500Native");

        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TREE, null);
        if (saved != null) {
            Uri u = Uri.parse(saved);
            for (UriPermission p : getContentResolver().getPersistedUriPermissions())
                if (p.getUri().equals(u) && p.isWritePermission()) tree = u;
        }
        midiManager = (MidiManager) getSystemService(Context.MIDI_SERVICE);
        if (midiManager != null) {
            // Let the editor connect by itself when the pedal is plugged in.
            midiManager.registerDeviceCallback(new MidiManager.DeviceCallback() {
                @Override
                public void onDeviceAdded(MidiDeviceInfo info) {
                    if (score(info) > 0) web.evaluateJavascript("window.__rcMidiAdded&&__rcMidiAdded()", null);
                }
            }, ui);
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.rc500Back&&rc500Back()", r -> { if (!"true".equals(r)) finish(); });
    }

    @Override
    protected void onDestroy() {
        closeMidi();
        closeRead();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ JS callbacks

    private void reply(int id, boolean ok, String payload) {
        String js = "window.__rcNative&&__rcNative(" + id + "," + ok + "," + JSONObject.quote(payload == null ? "" : payload) + ")";
        ui.post(() -> web.evaluateJavascript(js, null));
    }

    private static String err(Exception e) {
        String m = e.getMessage();
        return "ERR:" + (m == null ? e.getClass().getSimpleName() : m);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        Uri uri = data != null && resultCode == RESULT_OK ? data.getData() : null;
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
            fileCallback = null;
        } else if (requestCode == REQ_FOLDER) {
            if (uri == null) { reply(pendingFolderId, false, "Cancelled"); return; }
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (SecurityException ignored) { }
            tree = uri;
            synchronized (docIds) { docIds.clear(); }
            closeRead();
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_TREE, uri.toString()).apply();
            reply(pendingFolderId, true, folderName());
        } else if (requestCode == REQ_SAVE) {
            if (uri == null) { reply(pendingSaveId, false, "Cancelled"); return; }
            try {
                ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(uri, "wt");
                if (pfd == null) throw new IOException("Cannot write the file");
                String token = newWriter(new Out(pfd));
                reply(pendingSaveId, true, token);
            } catch (Exception e) { reply(pendingSaveId, false, e.getMessage()); }
        }
    }

    // ------------------------------------------------------------------ storage helpers (paths relative to the picked folder)

    private String folderName() {
        if (tree == null) return "";
        String root = DocumentsContract.getTreeDocumentId(tree);
        String name = queryName(DocumentsContract.buildDocumentUriUsingTree(tree, root));
        if (name == null || name.isEmpty()) {
            int i = root.lastIndexOf(':');
            name = i >= 0 && i < root.length() - 1 ? root.substring(i + 1) : root;
        }
        return name;
    }

    private String queryName(Uri doc) {
        try (Cursor c = getContentResolver().query(doc, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return null;
    }

    /** Children of a document: name -> {id, mime, size}. */
    private JSONArray children(String parentId) throws Exception {
        JSONArray out = new JSONArray();
        Uri u = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        try (Cursor c = getContentResolver().query(u, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE}, null, null, null)) {
            if (c == null) return out;
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                o.put("id", c.getString(0));
                o.put("name", c.getString(1));
                o.put("dir", DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2)));
                o.put("size", c.isNull(3) ? 0 : c.getLong(3));
                out.put(o);
            }
        }
        return out;
    }

    /** Document id for a relative path, or null. */
    private String resolve(String path) throws Exception {
        if (tree == null) throw new IOException("No folder picked");
        String id = DocumentsContract.getTreeDocumentId(tree);
        if (path == null || path.isEmpty()) return id;
        synchronized (docIds) { String c = docIds.get(path); if (c != null) return c; }
        String sofar = "";
        for (String part : path.split("/")) {
            if (part.isEmpty()) continue;
            sofar = sofar.isEmpty() ? part : sofar + "/" + part;
            String cached;
            synchronized (docIds) { cached = docIds.get(sofar); }
            if (cached != null) { id = cached; continue; }
            JSONArray ch = children(id);
            String found = null;
            for (int i = 0; i < ch.length(); i++) {
                JSONObject o = ch.getJSONObject(i);
                if (o.getString("name").equalsIgnoreCase(part)) { found = o.getString("id"); break; }
            }
            if (found == null) return null;
            synchronized (docIds) { docIds.put(sofar, found); }
            id = found;
        }
        return id;
    }

    private Uri docUri(String id) { return DocumentsContract.buildDocumentUriUsingTree(tree, id); }

    /** Make sure the folders in path exist, return the parent's document id. */
    private String ensureParent(String path) throws Exception {
        String parent = DocumentsContract.getTreeDocumentId(tree), sofar = "";
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            if (parts[i].isEmpty()) continue;
            sofar = sofar.isEmpty() ? parts[i] : sofar + "/" + parts[i];
            String id = resolve(sofar);
            if (id == null) {
                Uri created = DocumentsContract.createDocument(getContentResolver(), docUri(parent),
                        DocumentsContract.Document.MIME_TYPE_DIR, parts[i]);
                if (created == null) throw new IOException("Cannot create folder " + sofar);
                id = DocumentsContract.getDocumentId(created);
                synchronized (docIds) { docIds.put(sofar, id); }
            }
            parent = id;
        }
        return parent;
    }

    private String newWriter(Out o) {
        synchronized (writers) { String t = "w" + (nextToken++); writers.put(t, o); return t; }
    }

    private void closeRead() {
        if (readStream != null) try { readStream.close(); } catch (IOException ignored) { }
        readStream = null; readPath = null; readPos = 0;
    }

    // ------------------------------------------------------------------ MIDI

    private void startClock() {
        if (clockThread != null && clockThread.isAlive()) return;
        clockRun = true;
        clockThread = new Thread(() -> {
            final byte[] tick = {(byte) 0xF8};
            long next = System.nanoTime();
            int n = 0;
            while (clockRun) {
                long now = System.nanoTime();
                if (now < next) { LockSupport.parkNanos(next - now); continue; }
                MidiInputPort p = midiIn;
                if (p != null) try { p.send(tick, 0, 1); } catch (IOException ignored) { }
                if (n++ % 24 == 0) ui.post(() -> web.evaluateJavascript("window.__rcBeat&&__rcBeat()", null));
                next += (long) (60e9 / (clockBpm * 24));
                if (System.nanoTime() - next > 100_000_000L) next = System.nanoTime(); // fell far behind: resync
            }
        }, "midi-clock");
        clockThread.setPriority(Thread.MAX_PRIORITY);
        clockThread.start();
    }

    private void stopClock() {
        clockRun = false;
        if (clockThread != null) clockThread.interrupt();
        clockThread = null;
    }

    private void closeMidi() {
        stopClock();
        try { if (midiOut != null) midiOut.close(); } catch (IOException ignored) { }
        try { if (midiIn != null) midiIn.close(); } catch (IOException ignored) { }
        try { if (midiDevice != null) midiDevice.close(); } catch (IOException ignored) { }
        if (deviceCallback != null && midiManager != null) midiManager.unregisterDeviceCallback(deviceCallback);
        midiOut = null; midiIn = null; midiDevice = null; deviceCallback = null;
    }

    private static int score(MidiDeviceInfo info) {
        Bundle p = info.getProperties();
        String all = (p.getString(MidiDeviceInfo.PROPERTY_NAME, "") + " " + p.getString(MidiDeviceInfo.PROPERTY_PRODUCT, "")
                + " " + p.getString(MidiDeviceInfo.PROPERTY_MANUFACTURER, "")).toUpperCase();
        int s = 0;
        if (all.contains("RC-500") || all.contains("RC500")) s += 4;
        if (all.contains("BOSS") || all.contains("ROLAND")) s += 2;
        if (info.getType() == MidiDeviceInfo.TYPE_USB) s += 1;
        if (info.getInputPortCount() == 0 || info.getOutputPortCount() == 0) s = -1;
        return s;
    }

    private static String deviceName(MidiDeviceInfo info) {
        Bundle p = info.getProperties();
        String n = p.getString(MidiDeviceInfo.PROPERTY_NAME);
        if (n == null) n = p.getString(MidiDeviceInfo.PROPERTY_PRODUCT, "MIDI device");
        return n;
    }

    @SuppressWarnings("deprecation")
    private void openMidi(int id) {
        if (midiManager == null) { reply(id, false, "This phone has no MIDI support"); return; }
        closeMidi();
        MidiDeviceInfo best = null; int bestScore = 0;
        for (MidiDeviceInfo info : midiManager.getDevices()) {
            int sc = score(info);
            if (sc > bestScore) { best = info; bestScore = sc; }
        }
        if (best == null) {
            reply(id, false, "No USB MIDI device found. Connect the RC-500 with a USB-C/OTG data cable and try again.");
            return;
        }
        final MidiDeviceInfo info = best;
        midiManager.openDevice(info, device -> {
            if (device == null) { reply(id, false, "Could not open " + deviceName(info)); return; }
            midiDevice = device;
            midiIn = device.openInputPort(0);
            midiOut = device.openOutputPort(0);
            if (midiIn == null) { closeMidi(); reply(id, false, "The MIDI port is busy (another app may be using it)"); return; }
            if (midiOut != null) midiOut.connect(new MidiReceiver() {
                @Override
                public void onSend(byte[] msg, int offset, int count, long timestamp) {
                    String b64 = Base64.encodeToString(msg, offset, count, Base64.NO_WRAP);
                    ui.post(() -> web.evaluateJavascript("window.__rcMidiIn&&__rcMidiIn('" + b64 + "')", null));
                }
            });
            deviceCallback = new MidiManager.DeviceCallback() {
                @Override
                public void onDeviceRemoved(MidiDeviceInfo removed) {
                    if (removed.getId() == info.getId()) {
                        closeMidi();
                        web.evaluateJavascript("window.__rcMidiClosed&&__rcMidiClosed()", null);
                    }
                }
            };
            midiManager.registerDeviceCallback(deviceCallback, ui);
            reply(id, true, deviceName(info));
        }, ui);
    }

    // ------------------------------------------------------------------ the bridge

    private class Bridge {
        @JavascriptInterface
        public String currentFolder() {
            if (tree == null) return "";
            try { children(DocumentsContract.getTreeDocumentId(tree)); return folderName(); } // still reachable?
            catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public boolean hasFolder() { return tree != null; }

        @JavascriptInterface
        public void pickFolder(int id) {
            ui.post(() -> {
                pendingFolderId = id;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try { startActivityForResult(i, REQ_FOLDER); }
                catch (ActivityNotFoundException e) { reply(id, false, "No folder picker available"); }
            });
        }

        @JavascriptInterface
        public String list(String path) {
            try {
                String id = resolve(path);
                JSONArray out = new JSONArray();
                if (id == null) return out.toString();
                JSONArray ch = children(id);
                for (int i = 0; i < ch.length(); i++) {
                    JSONObject o = ch.getJSONObject(i);
                    String p = path.isEmpty() ? o.getString("name") : path + "/" + o.getString("name");
                    synchronized (docIds) { docIds.put(p, o.getString("id")); }
                    JSONObject r = new JSONObject();
                    r.put("name", o.getString("name"));
                    r.put("dir", o.getBoolean("dir"));
                    out.put(r);
                }
                return out.toString();
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String size(String path) {
            try {
                String id = resolve(path);
                if (id == null) return "-1";
                try (Cursor c = getContentResolver().query(docUri(id), new String[]{DocumentsContract.Document.COLUMN_SIZE}, null, null, null)) {
                    if (c != null && c.moveToFirst()) return String.valueOf(c.getLong(0));
                }
                return "-1";
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String readChunk(String path, double offsetD, int length) {
            long offset = (long) offsetD;
            try {
                synchronized (MainActivity.this) {
                    if (readStream == null || !path.equals(readPath) || readPos != offset) {
                        closeRead();
                        String id = resolve(path);
                        if (id == null) throw new IOException("Not found: " + path);
                        readStream = getContentResolver().openInputStream(docUri(id));
                        if (readStream == null) throw new IOException("Cannot open " + path);
                        long skip = offset;
                        while (skip > 0) { long n = readStream.skip(skip); if (n <= 0) break; skip -= n; }
                        readPath = path; readPos = offset;
                    }
                    byte[] buf = new byte[length];
                    int got = 0;
                    while (got < length) { int n = readStream.read(buf, got, length - got); if (n < 0) break; got += n; }
                    readPos += got;
                    if (got < length) closeRead();
                    return Base64.encodeToString(buf, 0, got, Base64.NO_WRAP);
                }
            } catch (Exception e) { closeRead(); return err(e); }
        }

        @JavascriptInterface
        public String writeBegin(String path) {
            try {
                synchronized (MainActivity.this) { if (path.equals(readPath)) closeRead(); }
                String id = resolve(path);
                Uri uri;
                if (id == null) {
                    String parent = ensureParent(path);
                    String name = path.substring(path.lastIndexOf('/') + 1);
                    String mime = name.toLowerCase().endsWith(".wav") ? "audio/wav" : "application/octet-stream";
                    uri = DocumentsContract.createDocument(getContentResolver(), docUri(parent), mime, name);
                    if (uri == null) throw new IOException("Cannot create " + path);
                    synchronized (docIds) { docIds.put(path, DocumentsContract.getDocumentId(uri)); }
                } else uri = docUri(id);
                ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(uri, "wt");
                if (pfd == null) throw new IOException("Cannot write " + path);
                return newWriter(new Out(pfd));
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String writeChunk(String token, String b64) {
            Out o;
            synchronized (writers) { o = writers.get(token); }
            if (o == null) return "ERR:Bad write handle";
            try { o.os.write(Base64.decode(b64, Base64.DEFAULT)); return "ok"; }
            catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String writeEnd(String token) {
            Out o;
            synchronized (writers) { o = writers.remove(token); }
            if (o == null) return "ERR:Bad write handle";
            try {
                o.os.flush();
                try { o.pfd.getFileDescriptor().sync(); } catch (Exception ignored) { } // flush to the USB drive
                o.os.close();
                o.pfd.close();
                return "ok";
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String remove(String path) {
            try {
                synchronized (MainActivity.this) { if (path.equals(readPath)) closeRead(); }
                String id = resolve(path);
                if (id == null) return "ok";
                DocumentsContract.deleteDocument(getContentResolver(), docUri(id));
                synchronized (docIds) { docIds.remove(path); }
                return "ok";
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public void saveAs(int id, String name, String mime) {
            ui.post(() -> {
                pendingSaveId = id;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); }
                catch (ActivityNotFoundException e) { reply(id, false, "No file picker available"); }
            });
        }

        @JavascriptInterface
        public void midiOpen(int id) { ui.post(() -> openMidi(id)); }

        @JavascriptInterface
        public String midiSend(String b64) {
            MidiInputPort p = midiIn;
            if (p == null) return "ERR:MIDI not connected";
            try { byte[] b = Base64.decode(b64, Base64.DEFAULT); p.send(b, 0, b.length); return "ok"; }
            catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String midiClockStart(double bpm) {
            if (midiIn == null) return "ERR:MIDI not connected";
            clockBpm = Math.max(20, Math.min(300, bpm));
            startClock();
            return "ok";
        }

        @JavascriptInterface
        public String midiClockSet(double bpm) { clockBpm = Math.max(20, Math.min(300, bpm)); return "ok"; }

        @JavascriptInterface
        public void midiClockStop() { stopClock(); }

        @JavascriptInterface
        public void midiClose() { ui.post(MainActivity.this::closeMidi); }
    }
}

package com.hafij.housecost;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;

/**
 * Updates the APK from the latest GitHub release of Hafij-DEU/house-cost.
 * check() looks up the release; install() downloads the APK it found, makes sure it is this
 * app, newer and signed with the same key, then hands it to the system installer (the user
 * confirms there; app data stays). Results go to the page as window.__houseUpdate({state, ...}).
 */
final class Updater {

    private static final String LATEST = "https://api.github.com/repos/Hafij-DEU/house-cost/releases/latest";

    private final MainActivity activity;
    private String apkUrl;
    private String apkVersion;
    private volatile boolean busy;

    Updater(MainActivity activity) {
        this.activity = activity;
    }

    /** Same formula as versionCode in app/build.gradle. */
    static int code(String version) {
        String[] parts = version.replaceFirst("^v", "").replaceAll("[-+].*$", "").split("\\.");
        int[] n = new int[3];
        for (int i = 0; i < 3 && i < parts.length; i++) {
            try {
                n[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException e) {
                n[i] = 0;
            }
        }
        return n[0] * 10000 + n[1] * 100 + n[2];
    }

    void check() {
        if (busy) return;
        busy = true;
        new Thread(() -> {
            try {
                JSONObject release = new JSONObject(get(LATEST));
                String version = release.getString("tag_name").replaceFirst("^v", "");
                JSONArray assets = release.optJSONArray("assets");
                JSONObject apk = null;
                for (int i = 0; assets != null && i < assets.length(); i++) {
                    JSONObject a = assets.getJSONObject(i);
                    if (a.getString("name").endsWith(".apk")) apk = a;
                }
                if (apk == null || code(version) <= BuildConfig.VERSION_CODE) {
                    report(new JSONObject().put("state", "none").put("version", BuildConfig.VERSION_NAME));
                    return;
                }
                apkUrl = apk.getString("browser_download_url");
                apkVersion = version;
                report(new JSONObject().put("state", "available").put("version", version)
                    .put("size", apk.optLong("size")).put("notes", release.optString("body")));
            } catch (Exception e) {
                fail("net", e);
            } finally {
                busy = false;
            }
        }).start();
    }

    void install() {
        if (busy || apkUrl == null) return;
        PackageManager pm = activity.getPackageManager();
        if (!pm.canRequestPackageInstalls()) {
            // The user allows "install unknown apps" for House Cost once, then taps Update again.
            activity.runOnUiThread(() -> activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName()))));
            reportQuietly("permission");
            return;
        }
        busy = true;
        new Thread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create the update folder");
                File file = new File(dir, "HouseCost-" + apkVersion + ".apk");
                download(apkUrl, file);
                String problem = checkApk(pm, file);
                if (problem != null) {
                    file.delete();
                    report(new JSONObject().put("state", "error").put("code", problem));
                    return;
                }
                Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", file);
                Intent view = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.runOnUiThread(() -> activity.startActivity(view));
                report(new JSONObject().put("state", "installing").put("version", apkVersion));
            } catch (Exception e) {
                fail("download", e);
            } finally {
                busy = false;
            }
        }).start();
    }

    /** Returns null when the file is a newer House Cost signed like this one, else an error code. */
    private String checkApk(PackageManager pm, File file) throws PackageManager.NameNotFoundException {
        PackageInfo apk = pm.getPackageArchiveInfo(file.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (apk == null || !activity.getPackageName().equals(apk.packageName)) return "wrongApp";
        if (apk.getLongVersionCode() <= BuildConfig.VERSION_CODE) return "notNewer";
        PackageInfo me = pm.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (apk.signingInfo != null && me.signingInfo != null) {
            Signature[] theirs = apk.signingInfo.getApkContentsSigners();
            Signature[] mine = me.signingInfo.getApkContentsSigners();
            if (!Arrays.equals(theirs, mine)) return "wrongKey";
        }
        return null;
    }

    private static HttpURLConnection open(String url, String accept) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "HouseCost/" + BuildConfig.VERSION_NAME);
        c.setRequestProperty("Accept", accept);
        if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
        return c;
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = open(url, "application/vnd.github+json");
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            in.transferTo(out);
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    private void download(String url, File file) throws IOException, JSONException {
        HttpURLConnection c = open(url, "application/octet-stream");
        long total = c.getContentLengthLong();
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(file)) {
            byte[] buf = new byte[65536];
            long done = 0;
            int lastPct = -1, n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                int pct = total > 0 ? (int) (done * 100 / total) : -1;
                if (pct >= lastPct + 5) {
                    lastPct = pct;
                    report(new JSONObject().put("state", "downloading").put("pct", pct));
                }
            }
        } finally {
            c.disconnect();
        }
    }

    private void fail(String code, Exception e) {
        Log.w("HouseCost", "Update " + code + " failed", e);
        try {
            report(new JSONObject().put("state", "error").put("code", code).put("message", String.valueOf(e.getMessage())));
        } catch (JSONException ignored) {
            // Cannot happen with string values.
        }
    }

    private void reportQuietly(String state) {
        try {
            report(new JSONObject().put("state", state));
        } catch (JSONException ignored) {
            // Cannot happen with string values.
        }
    }

    private void report(JSONObject info) {
        activity.callPage("window.__houseUpdate && window.__houseUpdate(" + info + ")");
    }
}

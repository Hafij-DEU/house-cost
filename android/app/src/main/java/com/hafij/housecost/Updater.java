package com.hafij.housecost;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Finds updates in the latest GitHub release of Hafij-DEU/house-cost.
 * check() looks up the release; install() opens the APK it found in the browser, which
 * downloads it, and the user installs it from there (Android only accepts it when it is
 * signed with the same key; app data stays). The app never installs APKs itself: Play
 * Protect flags sideloaded apps that do. Results go to the page as window.__houseUpdate({state, ...}).
 */
final class Updater {

    private static final String LATEST = "https://api.github.com/repos/Hafij-DEU/house-cost/releases/latest";

    private final MainActivity activity;
    private String apkUrl;
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
        String url = apkUrl;
        if (url == null || !url.startsWith("https://github.com/")) return;
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addCategory(Intent.CATEGORY_BROWSABLE));
                reportQuietly("opened");
            } catch (ActivityNotFoundException e) {
                fail("browser", e);
            }
        });
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "HouseCost/" + BuildConfig.VERSION_NAME);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                in.transferTo(out);
                return out.toString("UTF-8");
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

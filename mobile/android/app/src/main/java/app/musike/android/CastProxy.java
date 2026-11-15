package app.musike.android;

import android.util.Log;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The cast device streams from here: a tiny HTTP server on the phone's Wi-Fi address that forwards each request,
 * Range included, to the YouTube stream the app resolved. The device can't fetch YouTube's URL itself — it is bound
 * to the client that asked for it — so the bytes go through the phone, as they do through the desktop app.
 *
 * It answers only /<secret>/<n>, for the last few tracks handed to it, and nothing else.
 */
final class CastProxy {

    private static final String TAG = "MusikeCast";

    private static final class Target {
        final String url;
        final String userAgent;

        Target(String url, String userAgent) {
            this.url = url;
            this.userAgent = userAgent;
        }
    }

    private final String secret;
    private final Map<String, Target> targets = Collections.synchronizedMap(
        new LinkedHashMap<String, Target>() {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Target> eldest) {
                return size() > 4; // the previous track may still be finishing a request
            }
        }
    );
    private int counter;
    private ServerSocket server;
    private String host;

    CastProxy() {
        byte[] bytes = new byte[12];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b));
        secret = sb.toString();
    }

    /** The URL the device should play for this stream. Starts the server on the address facing the device. */
    synchronized String register(String url, String userAgent, InetAddress device) throws IOException {
        ensureStarted(device);
        String id = Integer.toString(++counter);
        targets.put(id, new Target(url, userAgent));
        return "http://" + host + ":" + server.getLocalPort() + "/" + secret + "/" + id;
    }

    synchronized void stop() {
        targets.clear();
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {}
        }
        server = null;
        host = null;
    }

    private void ensureStarted(InetAddress device) throws IOException {
        InetAddress local = addressFacing(device);
        if (local == null) throw new IOException("noNetwork");
        String address = local.getHostAddress();
        if (server != null && !server.isClosed() && address.equals(host)) return;
        if (server != null) server.close();
        ServerSocket socket = new ServerSocket(0, 16, local);
        server = socket;
        host = address;
        Thread accept = new Thread(() -> {
            while (!socket.isClosed()) {
                try {
                    Socket client = socket.accept();
                    Thread worker = new Thread(() -> serve(client), "MusikeCastProxy");
                    worker.setDaemon(true);
                    worker.start();
                } catch (IOException e) {
                    if (!socket.isClosed()) Log.w(TAG, "accept failed", e);
                }
            }
        }, "MusikeCastAccept");
        accept.setDaemon(true);
        accept.start();
    }

    private void serve(Socket client) {
        HttpURLConnection upstream = null;
        try (Socket c = client) {
            c.setSoTimeout(30_000);
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.ISO_8859_1));
            OutputStream out = c.getOutputStream();
            String requestLine = in.readLine();
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "";
            String path = parts.length > 1 ? parts[1].split("\\?")[0] : "";
            String range = null;
            for (String line; (line = in.readLine()) != null && !line.isEmpty(); ) {
                int colon = line.indexOf(':');
                if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("range")) range = line.substring(colon + 1).trim();
            }

            if (method.equals("OPTIONS")) {
                head(out, 204, "No Content", "Access-Control-Allow-Headers: Range\r\n");
                return;
            }
            String[] segments = path.split("/");
            Target target = segments.length == 3 && secret.equals(segments[1]) ? targets.get(segments[2]) : null;
            if (target == null) {
                head(out, 404, "Not Found", "Content-Length: 0\r\n");
                return;
            }
            if (!method.equals("GET") && !method.equals("HEAD")) {
                head(out, 405, "Method Not Allowed", "Content-Length: 0\r\n");
                return;
            }

            upstream = (HttpURLConnection) new URL(target.url).openConnection();
            upstream.setRequestMethod(method);
            upstream.setConnectTimeout(15_000);
            upstream.setReadTimeout(30_000);
            if (target.userAgent != null && !target.userAgent.isEmpty()) upstream.setRequestProperty("User-Agent", target.userAgent);
            if (range != null) upstream.setRequestProperty("Range", range);
            int status = upstream.getResponseCode();

            StringBuilder headers = new StringBuilder();
            for (String name : new String[] { "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges" }) {
                String value = upstream.getHeaderField(name);
                if (value != null) headers.append(name).append(": ").append(value).append("\r\n");
            }
            if (upstream.getHeaderField("Accept-Ranges") == null) headers.append("Accept-Ranges: bytes\r\n");
            String message = upstream.getResponseMessage();
            head(out, status, message == null ? "OK" : message, headers.toString());
            if (method.equals("HEAD")) return;

            InputStream body = status >= 400 ? upstream.getErrorStream() : upstream.getInputStream();
            if (body == null) return;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream b = body) {
                for (int n; (n = b.read(buffer)) != -1; ) out.write(buffer, 0, n);
            }
            out.flush();
        } catch (IOException ignored) {
            // the device closed the connection (seek, next track): normal
        } finally {
            if (upstream != null) upstream.disconnect();
        }
    }

    private static void head(OutputStream out, int status, String message, String headers) throws IOException {
        String text = "HTTP/1.1 " + status + " " + message + "\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n" +
            headers +
            "\r\n";
        out.write(text.getBytes(StandardCharsets.ISO_8859_1));
    }

    /** The phone's IPv4 address on the device's subnet; without a known device, the Wi-Fi's. */
    private static InetAddress addressFacing(InetAddress device) {
        InetAddress fallback = null;
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    if (device instanceof Inet4Address && sameSubnet(a, device, ia.getNetworkPrefixLength())) return a;
                    if (fallback == null || nif.getName().startsWith("wlan")) fallback = a;
                }
            }
        } catch (IOException e) {
            Log.w(TAG, "no network interfaces", e);
        }
        return fallback;
    }

    private static boolean sameSubnet(InetAddress a, InetAddress b, int prefix) {
        byte[] x = a.getAddress();
        byte[] y = b.getAddress();
        for (int bit = 0; bit < prefix; bit++) {
            int mask = 0x80 >> (bit % 8);
            if ((x[bit / 8] & mask) != (y[bit / 8] & mask)) return false;
        }
        return true;
    }
}

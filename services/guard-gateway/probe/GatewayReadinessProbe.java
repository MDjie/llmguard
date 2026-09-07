import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** No public management listener or extra curl/wget dependency is needed. */
public final class GatewayReadinessProbe {
    public static void main(String[] args) {
        try {
            String kind = args.length == 1 && args[0].equals("liveness") ? "liveness" : "readiness";
            var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:8081/actuator/health/" + kind)).timeout(Duration.ofSeconds(2)).GET().build();
            var response = client.send(request, HttpResponse.BodyHandlers.discarding());
            System.exit(response.statusCode() == 200 ? 0 : 1);
        } catch (Exception error) { System.exit(1); }
    }
}

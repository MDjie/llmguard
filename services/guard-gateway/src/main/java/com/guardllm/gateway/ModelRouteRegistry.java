package com.guardllm.gateway;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Component
final class ModelRouteRegistry {
    record Selection(
            String routeId,
            URI chatUri,
            String bearerToken,
            ObjectNode request,
            List<JsonFieldMapper.Rule> responseMappings) {
    }

    private record Route(
            String id,
            URI baseUrl,
            String modelPattern,
            String targetModel,
            int weight,
            String bearerToken,
            List<JsonFieldMapper.Rule> requestMappings,
            List<JsonFieldMapper.Rule> responseMappings) {
    }

    private final List<Route> routes;
    private final JsonNode declaredRoutes;
    private final String defaultBaseUrl;

    @org.springframework.beans.factory.annotation.Autowired
    ModelRouteRegistry(
            ObjectMapper objectMapper,
            GuardGatewayProperties gateway,
            GatewayModelRoutingProperties routing) {
        this(
                objectMapper,
                configuredRoutes(routing.routesJson()),
                gateway.modelBaseUrl(),
                gateway.modelBearerToken(),
                System::getenv);
    }

    ModelRouteRegistry(
            ObjectMapper objectMapper,
            String routesJson,
            URI defaultBaseUrl,
            String defaultBearerToken,
            Function<String, String> environment) {
        this.declaredRoutes = routesJson == null || routesJson.isBlank() ? objectMapper.nullNode() : objectMapper.readTree(routesJson);
        this.defaultBaseUrl = defaultBaseUrl.toString();
        this.routes = routesJson == null || routesJson.isBlank()
                ? List.of(new Route(
                        "default", validateBaseUrl(defaultBaseUrl), "*", "", 100,
                        defaultBearerToken == null ? "" : defaultBearerToken,
                        List.of(), List.of()))
                : parseRoutes(objectMapper, routesJson, environment);
    }

    private static String configuredRoutes(String configured) {
        String value = GatewaySettings.read("GUARD_MODEL_ROUTES_JSON", "GUARD_MODEL_ROUTES_FILE");
        return value == null || value.isBlank() ? configured : value;
    }

    JsonNode signedConfiguration(ObjectMapper mapper, JsonNode boundaries) {
        ObjectNode configuration = mapper.createObjectNode().put("defaultBaseUrl", defaultBaseUrl).put("defaultBearerTokenRef", "MODEL_BEARER_TOKEN");
        configuration.set("routes", declaredRoutes);
        configuration.set("boundaries", boundaries);
        return configuration;
    }

    JsonNode validateSnapshot(ObjectMapper mapper, JsonNode manifest) {
        String configured = GatewaySettings.read("GATEWAY_MODEL_ROUTE_BOUNDARIES_JSON", "GATEWAY_MODEL_ROUTE_BOUNDARIES_FILE");
        JsonNode boundaries = mapper.readTree(configured == null ? "{}" : configured);
        validateSnapshot(mapper, manifest, boundaries);
        return boundaries;
    }

    void validateSnapshot(ObjectMapper mapper, JsonNode manifest, JsonNode boundaries) {
        JsonNode pinned = manifest.path("modelRouting");
        String canonical = CanonicalJson.encode(signedConfiguration(mapper, boundaries));
        if (!pinned.path("configurationJson").isString() || !canonical.equals(pinned.path("configurationJson").stringValue())
                || !CanonicalJson.sha256(canonical).equals(pinned.path("configurationDigest").stringValue())) {
            throw new GatewayFailure("MODEL_ROUTING_SNAPSHOT_MISMATCH", 503);
        }
    }

    Selection select(JsonNode original, String routeKey) {
        if (!original.isObject()) throw new IllegalArgumentException("Model request must be an object");
        String requestedModel = original.path("model").isString()
                ? original.path("model").stringValue() : "";
        List<Route> exact = routes.stream().filter(route -> route.id().equals(requestedModel)).toList();
        List<Route> candidates = exact.isEmpty() ? routes.stream()
                .filter(route -> "*".equals(route.modelPattern()) || route.modelPattern().equals(requestedModel))
                .toList() : exact;
        if (candidates.isEmpty()) {
            throw new IllegalArgumentException("No configured model route matches the requested model");
        }
        int totalWeight = candidates.stream().mapToInt(Route::weight).sum();
        int bucket = Math.floorMod(stableHash(routeKey + "\n" + requestedModel), totalWeight);
        Route selected = candidates.getLast();
        int cursor = 0;
        for (Route candidate : candidates) {
            cursor += candidate.weight();
            if (bucket < cursor) {
                selected = candidate;
                break;
            }
        }
        ObjectNode mapped = (ObjectNode) original.deepCopy();
        if (!selected.targetModel().isBlank()) mapped.put("model", selected.targetModel());
        mapped = JsonFieldMapper.apply(mapped, selected.requestMappings());
        return new Selection(
                selected.id(),
                chatUri(selected.baseUrl()),
                selected.bearerToken(),
                mapped,
                selected.responseMappings());
    }

    JsonNode normalize(Selection selection, JsonNode response) {
        if (!response.isObject()) return response;
        return JsonFieldMapper.apply((ObjectNode) response, selection.responseMappings());
    }

    private static List<Route> parseRoutes(
            ObjectMapper objectMapper,
            String json,
            Function<String, String> environment) {
        try {
            JsonNode root = objectMapper.readTree(json);
            if (!root.isArray() || root.isEmpty() || root.size() > 32) {
                throw new IllegalArgumentException("Model routes must contain 1..32 entries");
            }
            List<Route> result = new ArrayList<>();
            Set<String> ids = new HashSet<>();
            for (JsonNode item : root) {
                String id = bounded(item.path("id").stringValue(), "route id");
                if (!ids.add(id)) throw new IllegalArgumentException("Model route ids must be unique");
                URI baseUrl = validateBaseUrl(URI.create(
                        bounded(item.path("baseUrl").stringValue(), "route baseUrl")));
                String modelPattern = item.path("modelPattern").isString()
                        ? bounded(item.path("modelPattern").stringValue(), "modelPattern") : "*";
                String targetModel = item.path("targetModel").isString()
                        ? bounded(item.path("targetModel").stringValue(), "targetModel") : "";
                int weight = item.path("weight").asInt(0);
                if (weight < 1 || weight > 10_000) {
                    throw new IllegalArgumentException("Model route weight must be in range 1..10000");
                }
                String tokenEnv = item.path("bearerTokenEnv").isString()
                        ? bounded(item.path("bearerTokenEnv").stringValue(), "bearerTokenEnv") : "";
                String bearerToken = tokenEnv.isEmpty() ? "" : environment.apply(tokenEnv);
                if (!tokenEnv.isEmpty() && (bearerToken == null || bearerToken.isBlank())) {
                    throw new IllegalArgumentException("Model route bearer token environment is missing");
                }
                List<JsonFieldMapper.Rule> requestMappings = JsonFieldMapper.parse(
                        item.path("requestMappings"), "requestMappings");
                List<JsonFieldMapper.Rule> responseMappings = JsonFieldMapper.parse(
                        item.path("responseMappings"), "responseMappings");
                result.add(new Route(
                        id, baseUrl, modelPattern, targetModel, weight,
                        bearerToken == null ? "" : bearerToken,
                        requestMappings, responseMappings));
            }
            return List.copyOf(result);
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Model route JSON is invalid", error);
        }
    }

    private static URI validateBaseUrl(URI value) {
        if (value == null || value.getHost() == null || value.getUserInfo() != null
                || value.getFragment() != null || value.getQuery() != null) {
            throw new IllegalArgumentException("Model route base URL is invalid");
        }
        boolean loopback = "localhost".equalsIgnoreCase(value.getHost())
                || "127.0.0.1".equals(value.getHost())
                || "::1".equals(value.getHost());
        if (!"https".equalsIgnoreCase(value.getScheme())
                && !("http".equalsIgnoreCase(value.getScheme()) && loopback)) {
            throw new IllegalArgumentException("Model route must use HTTPS outside loopback development");
        }
        return value;
    }

    private static URI chatUri(URI baseUrl) {
        String path = baseUrl.getPath() == null ? "" : baseUrl.getPath().replaceAll("/+$", "");
        String suffix = path.endsWith("/v1") || path.contains("/api/v")
                || path.contains("/compatible-mode/v1")
                ? "/chat/completions" : "/v1/chat/completions";
        return baseUrl.resolve(path + suffix);
    }

    private static String bounded(String value, String name) {
        if (value == null) throw new IllegalArgumentException(name + " is required");
        String candidate = value.trim();
        if (candidate.isEmpty() || candidate.length() > 256
                || candidate.indexOf('\r') >= 0 || candidate.indexOf('\n') >= 0) {
            throw new IllegalArgumentException(name + " is invalid");
        }
        return candidate;
    }

    private static int stableHash(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return java.nio.ByteBuffer.wrap(digest, 0, 4).getInt();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}

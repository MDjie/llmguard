package com.guardllm.gateway;

import tools.jackson.databind.JsonNode;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;
import tools.jackson.databind.ObjectMapper;

@Component
final class ModelClient {
    private final WebClient webClient;
    private final ModelRouteRegistry routes;
    private final ObjectMapper objectMapper;

    ModelClient(
            @Qualifier("modelWebClient") WebClient webClient,
            ModelRouteRegistry routes,
            ObjectMapper objectMapper) {
        this.webClient = webClient;
        this.routes = routes;
        this.objectMapper = objectMapper;
    }

    Mono<JsonNode> chat(JsonNode request, String routeKey) {
        return chatRoute(routes.select(request, routeKey));
    }
    Mono<JsonNode> chatAuthorized(JsonNode request, String routeKey, JsonNode auth, JsonNode manifest) {
        return chatRoute(authorizedRoute(request, routeKey, auth, manifest));
    }
    private Mono<JsonNode> chatRoute(ModelRouteRegistry.Selection route) {
        WebClient.RequestBodySpec call = webClient.post().uri(route.chatUri())
                .contentType(MediaType.APPLICATION_JSON);
        if (route.bearerToken() != null && !route.bearerToken().isBlank()) {
            call.header(HttpHeaders.AUTHORIZATION, "Bearer " + route.bearerToken());
        }
        return call.bodyValue(route.request()).retrieve().bodyToMono(JsonNode.class)
                .map(response -> routes.normalize(route, response));
    }

    Flux<ServerSentEvent<String>> chatStream(JsonNode request, String routeKey) {
        return streamRoute(routes.select(request, routeKey));
    }
    Flux<ServerSentEvent<String>> chatStreamAuthorized(JsonNode request, String routeKey, JsonNode auth, JsonNode manifest) {
        return streamRoute(authorizedRoute(request, routeKey, auth, manifest));
    }
    private Flux<ServerSentEvent<String>> streamRoute(ModelRouteRegistry.Selection route) {
        WebClient.RequestBodySpec call = webClient.post().uri(route.chatUri())
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM);
        if (route.bearerToken() != null && !route.bearerToken().isBlank()) {
            call.header(HttpHeaders.AUTHORIZATION, "Bearer " + route.bearerToken());
        }
        return call.bodyValue(route.request()).retrieve().bodyToFlux(
                        new ParameterizedTypeReference<ServerSentEvent<String>>() { })
                .map(event -> normalizeEvent(route, event));
    }

    private ModelRouteRegistry.Selection authorizedRoute(JsonNode request, String routeKey, JsonNode auth, JsonNode manifest) {
        boolean permitted = false;
        for (JsonNode alias : auth.path("allowedModelRoutes")) if (alias.equals(request.path("model"))) permitted = true;
        if (!permitted) throw new GatewayFailure("MODEL_ROUTE_NOT_AUTHORIZED", 403);
        ModelRouteRegistry.Selection route = routes.select(request, routeKey);
        JsonNode boundaries = routes.validateSnapshot(objectMapper, manifest);
        boolean boundaryPermitted = false;
        for (JsonNode boundary : boundaries.path(route.routeId())) if (boundary.equals(auth.path("dataBoundary"))) boundaryPermitted = true;
        if (!boundaryPermitted) throw new GatewayFailure("MODEL_DATA_BOUNDARY_DENIED", 403);
        StructuredContent content = new StructuredContent(objectMapper);
        if (!content.segments(request, true, 131072).equals(content.segments(route.request(), true, 131072))) throw new GatewayFailure("MODEL_MAPPING_CHANGED_APPROVED_CONTENT", 403);
        return route;
    }

    private ServerSentEvent<String> normalizeEvent(
            ModelRouteRegistry.Selection route,
            ServerSentEvent<String> event) {
        String data = event.data();
        if (data == null || data.isBlank() || "[DONE]".equals(data.trim())) return event;
        try {
            JsonNode parsed = objectMapper.readTree(data);
            String normalized = objectMapper.writeValueAsString(routes.normalize(route, parsed));
            ServerSentEvent.Builder<String> builder = ServerSentEvent.builder(normalized);
            if (event.id() != null) builder.id(event.id());
            if (event.event() != null) builder.event(event.event());
            if (event.retry() != null) builder.retry(event.retry());
            if (event.comment() != null) builder.comment(event.comment());
            return builder.build();
        } catch (Exception error) {
            throw new IllegalArgumentException("Upstream returned malformed SSE JSON", error);
        }
    }
}

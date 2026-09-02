package com.guardllm.gateway;

import java.util.ArrayList;
import java.util.List;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

final class JsonFieldMapper {
    record Rule(String from, String to, boolean move) {
        Rule {
            validatePointer(from);
            validatePointer(to);
            if (wildcardCount(from) != wildcardCount(to) || wildcardCount(from) > 1) {
                throw new IllegalArgumentException(
                        "Field mapping pointers must contain the same optional wildcard");
            }
        }
    }

    private JsonFieldMapper() {
    }

    static List<Rule> parse(JsonNode node, String name) {
        if (node == null || node.isMissingNode() || node.isNull()) return List.of();
        if (!node.isArray() || node.size() > 32) {
            throw new IllegalArgumentException(name + " must contain at most 32 mappings");
        }
        List<Rule> result = new ArrayList<>();
        for (JsonNode item : node) {
            if (!item.isObject() || !item.path("from").isString() || !item.path("to").isString()) {
                throw new IllegalArgumentException(name + " entries require from and to pointers");
            }
            result.add(new Rule(
                    item.path("from").stringValue(),
                    item.path("to").stringValue(),
                    !item.has("move") || item.path("move").asBoolean(true)));
        }
        return List.copyOf(result);
    }

    static ObjectNode apply(ObjectNode input, List<Rule> rules) {
        if (rules.isEmpty()) return input;
        ObjectNode result = input.deepCopy();
        for (Rule rule : rules) {
            int wildcard = rule.from().indexOf("/*/");
            if (wildcard < 0) {
                applyOne(result, rule.from(), rule.to(), rule.move());
                continue;
            }
            String arrayPointer = rule.from().substring(0, wildcard);
            JsonNode values = result.at(arrayPointer);
            if (!values.isArray()) continue;
            for (int index = 0; index < values.size(); index += 1) {
                applyOne(
                        result,
                        rule.from().replace("/*/", "/" + index + "/"),
                        rule.to().replace("/*/", "/" + index + "/"),
                        rule.move());
            }
        }
        return result;
    }

    private static void applyOne(ObjectNode root, String from, String to, boolean move) {
        JsonNode value = root.at(from);
        if (value.isMissingNode()) return;
        set(root, tokens(to), value.deepCopy());
        if (move && !from.equals(to)) remove(root, tokens(from));
    }

    private static void set(ObjectNode root, List<String> path, JsonNode value) {
        JsonNode current = root;
        for (int index = 0; index < path.size() - 1; index += 1) {
            String token = path.get(index);
            if (current instanceof ObjectNode object) {
                JsonNode next = object.get(token);
                if (next == null || next.isNull()) next = object.putObject(token);
                current = next;
            } else if (current instanceof ArrayNode array) {
                current = array.path(parseIndex(token, array.size()));
            } else {
                throw new IllegalArgumentException("Field mapping target parent is not a container");
            }
            if (current.isMissingNode()) {
                throw new IllegalArgumentException("Field mapping array index does not exist");
            }
        }
        String leaf = path.getLast();
        if (current instanceof ObjectNode object) {
            object.set(leaf, value);
        } else if (current instanceof ArrayNode array) {
            array.set(parseIndex(leaf, array.size()), value);
        } else {
            throw new IllegalArgumentException("Field mapping target is not a container");
        }
    }

    private static void remove(ObjectNode root, List<String> path) {
        JsonNode current = root;
        for (int index = 0; index < path.size() - 1; index += 1) {
            String token = path.get(index);
            current = current instanceof ObjectNode object
                    ? object.path(token)
                    : current instanceof ArrayNode array
                            ? array.path(parseIndex(token, array.size()))
                            : null;
            if (current == null || current.isMissingNode()) return;
        }
        String leaf = path.getLast();
        if (current instanceof ObjectNode object) {
            object.remove(leaf);
        } else if (current instanceof ArrayNode array) {
            array.remove(parseIndex(leaf, array.size()));
        }
    }

    private static List<String> tokens(String pointer) {
        String[] raw = pointer.substring(1).split("/", -1);
        List<String> result = new ArrayList<>(raw.length);
        for (String token : raw) {
            result.add(token.replace("~1", "/").replace("~0", "~"));
        }
        return result;
    }

    private static int parseIndex(String value, int size) {
        try {
            int index = Integer.parseInt(value);
            if (index < 0 || index >= size) throw new IllegalArgumentException();
            return index;
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Field mapping array index is invalid", error);
        }
    }

    private static void validatePointer(String pointer) {
        if (pointer == null || pointer.length() < 2 || pointer.length() > 256
                || pointer.charAt(0) != '/' || pointer.endsWith("/")
                || pointer.contains("//") || pointer.contains("\r") || pointer.contains("\n")
                || (pointer.contains("*") && !pointer.contains("/*/"))) {
            throw new IllegalArgumentException("Field mapping JSON pointer is invalid");
        }
    }

    private static int wildcardCount(String value) {
        return value.contains("/*/") ? 1 : 0;
    }
}

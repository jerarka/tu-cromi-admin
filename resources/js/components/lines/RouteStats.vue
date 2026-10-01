<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';
import { describeRouteStats, routeStats } from '@/lib/routeEditing';

const props = defineProps<{
    /**
     * The route to measure, in the same shape LineMap takes.
     *
     * The geometry rather than the three numbers, so the caller has one thing to
     * pass and the measurement cannot be built from a stale mix of them.
     */
    geoJson: {
        type: 'MultiLineString';
        coordinates: number[][][];
    } | null;
}>();

/**
 * The three measurements, as one line, or null when there is nothing to say.
 *
 * Null rather than an empty badge: a route whose JSON is mid-edit and does not
 * parse has no vertex count, and "0 vertices" would be a confident claim about a
 * state that does not exist. The rule lives here rather than in the two
 * templates that render this, because a `v-if` copied into both pages is a
 * `v-if` that eventually gets changed in one of them.
 *
 * The measuring and the wording are pure functions in lib/, so what is left here
 * is the printing. That is not a style preference: vitest runs with
 * `environment: 'node'` and no jsdom, so a component cannot be tested at all and
 * anything worth asserting has to have been kept out of it.
 */
const summary = computed(() => {
    if (!props.geoJson) {
        return null;
    }

    return describeRouteStats(routeStats(props.geoJson.coordinates)) || null;
});
</script>

<template>
    <Badge v-if="summary" variant="secondary">{{ summary }}</Badge>
</template>

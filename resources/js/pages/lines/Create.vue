<script setup lang="ts">
import { Form, Head } from '@inertiajs/vue3';
import { ArrowLeft } from '@lucide/vue';
import { computed, ref } from 'vue';
import LineController from '@/actions/App/Http/Controllers/Admin/LineController';
import Heading from '@/components/Heading.vue';
import InputError from '@/components/InputError.vue';
import LineMap from '@/components/lines/LineMap.vue';
import RouteModePicker from '@/components/lines/RouteModePicker.vue';
import RouteStats from '@/components/lines/RouteStats.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouteGeometry } from '@/composables/useRouteGeometry';
import type { Waypoint } from '@/lib/guidedRouting';
import type { Coordinates } from '@/lib/routeEditing';

const {
    geoJsonText,
    parsedGeoJson,
    geoJsonError,
    isEditingMap,
    mode,
    editToggleLabel,
    markDirty,
    validateGeoJson,
    setGeometry,
    toggleEditing,
    confirmDiscard,
} = useRouteGeometry();

/**
 * The control points the guided mode accepted, owned here for the same
 * reason the geometry text is: a new line has no record yet, so the list is
 * client-only until the first save — where it becomes the line's recipe.
 */
const waypoints = ref<Waypoint[]>([]);

/**
 * Whether this visit actually touched the recipe.
 *
 * Same rule as the edit page: a new line whose reviewer never opened the
 * guided mode has no recipe to save, and sending the bootstrap's derived
 * controls would be inventing one.
 */
const waypointsTouched = ref(false);

/**
 * Tells the map to keep its framing across a guided accept.
 *
 * The same one-shot the edit page uses for undo and redo. A guided accept is
 * driven by a click on the map, so the geometry it produces is by definition
 * in view already — refitting the whole route underneath the reviewer is the
 * one thing that cannot help them here.
 */
const preserveViewToken = ref(0);

/**
 * The recipe as the form posts it — only when this visit touched it.
 */
const waypointsField = computed<string | null>(() => {
    // An empty list posts as '[]', which WaypointsPayload validates and
    // syncWaypoints([]) consumes by deleting the rows — see Edit.vue's
    // waypointsField for why an empty list is not the same as no field.
    if (!waypointsTouched.value) {
        return null;
    }

    return JSON.stringify(
        waypoints.value.map((waypoint) => ({
            lat: waypoint.position[1],
            lng: waypoint.position[0],
        })),
    );
});

/**
 * One guided result in, both halves stored.
 *
 * A guided accept is one edit, so this is one assignment pair and not two
 * events for the parent to race.
 */
function onGuidedUpdate(payload: {
    coordinates: Coordinates | null;
    waypoints: Waypoint[];
}): void {
    if (payload.coordinates !== null) {
        setGeometry({
            type: 'MultiLineString',
            coordinates: payload.coordinates,
        });
    }

    waypoints.value = payload.waypoints;
    waypointsTouched.value = true;
    preserveViewToken.value += 1;
    markDirty();
}
</script>

<template>
    <Head title="Create Line" />
    <Button
        type="button"
        variant="ghost"
        size="sm"
        class="-ml-3"
        @click="confirmDiscard"
    >
        <ArrowLeft class="size-4" />
        Back to lines
    </Button>
    <Heading
        title="Create Line"
        description="Add a new transport line and its route geometry"
    />

    <div class="grid gap-8 lg:grid-cols-2">
        <!-- Form -->
        <div>
            <Form
                v-bind="LineController.store.form()"
                class="grid grid-cols-2 gap-4"
                v-slot="{ errors, processing }"
            >
                <div class="grid gap-1">
                    <Label for="code">Code</Label>
                    <Input
                        id="code"
                        name="code"
                        placeholder="e.g. 1, 16 azul, 104 C"
                        @input="markDirty"
                    />
                    <InputError :message="errors.code" />
                    <p class="text-sm text-muted-foreground">
                        Identity, shared by both directions. A number, or a
                        lowercase slug for a service with no number (e.g.
                        la-guardia-nueva-terminal).
                    </p>
                </div>

                <div class="grid gap-1">
                    <Label for="sense">Direction</Label>
                    <select
                        id="sense"
                        name="sense"
                        class="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                        @change="markDirty"
                    >
                        <option value="">Select direction...</option>
                        <option value="OUTBOUND">OUTBOUND (Ida)</option>
                        <option value="RETURN">RETURN (Vuelta)</option>
                    </select>
                    <InputError :message="errors.sense" />
                </div>

                <div class="grid gap-1">
                    <Label for="name">Name</Label>
                    <Input
                        id="name"
                        name="name"
                        placeholder="Line display name"
                        @input="markDirty"
                    />
                    <InputError :message="errors.name" />
                    <p class="text-sm text-muted-foreground">
                        What riders read on the bus. For a slug code, this is
                        the only wording the app shows.
                    </p>
                </div>

                <div class="grid grid-cols-2">
                    <div class="grid gap-2">
                        <Label for="color">Color</Label>
                        <Input
                            id="color"
                            name="color"
                            placeholder="#3b82f6"
                            class="w-32"
                            @input="markDirty"
                        />
                        <InputError :message="errors.color" />
                    </div>

                    <div class="grid gap-2">
                        <Label for="syndicate">Syndicate</Label>
                        <Input
                            id="syndicate"
                            name="syndicate"
                            placeholder="Operating company"
                            @input="markDirty"
                        />
                        <InputError :message="errors.syndicate" />
                    </div>
                </div>

                <div class="col-span-2 grid gap-2">
                    <Label for="geo_json">Route geometry (GeoJSON)</Label>
                    <textarea
                        id="geo_json"
                        name="geo_json"
                        class="h-80 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs"
                        :value="geoJsonText"
                        @input="
                            geoJsonText = ($event.target as HTMLTextAreaElement)
                                .value;
                            validateGeoJson();
                            markDirty();
                        "
                        placeholder='{"type":"MultiLineString","coordinates":[[[...]]]}'
                    ></textarea>
                    <InputError :message="errors.geo_json" />
                    <p
                        v-if="geoJsonError"
                        class="text-sm text-red-600 dark:text-red-500"
                    >
                        {{ geoJsonError }}
                    </p>
                </div>
                <!-- The guided editor's control-point recipe, posted only when touched. -->
                <input
                    v-if="waypointsField !== null"
                    type="hidden"
                    name="waypoints"
                    :value="waypointsField"
                />
                <div class="flex items-center gap-4">
                    <Button :disabled="processing">Save</Button>
                    <Button
                        type="button"
                        variant="outline"
                        :disabled="processing"
                        @click="confirmDiscard"
                    >
                        Cancel
                    </Button>
                </div>
            </Form>
        </div>

        <!-- Map preview / editor -->
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <Label>Route preview</Label>
                    <RouteStats :geo-json="parsedGeoJson" />
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    @click="toggleEditing"
                >
                    {{ editToggleLabel }}
                </Button>
            </div>
            <LineMap
                :geo-json="parsedGeoJson"
                :editable="isEditingMap"
                :mode="mode"
                :guided-waypoints="waypoints"
                :preserve-view-token="preserveViewToken"
                @update:geo-json="setGeometry"
                @update:guided="onGuidedUpdate"
            >
                <template #toolbar>
                    <RouteModePicker v-if="isEditingMap" v-model="mode" />
                </template>
            </LineMap>
            <p
                v-if="!parsedGeoJson && geoJsonText"
                class="text-sm text-red-600 dark:text-red-500"
            >
                Fix JSON errors to see the route on the map.
            </p>
        </div>
    </div>
</template>

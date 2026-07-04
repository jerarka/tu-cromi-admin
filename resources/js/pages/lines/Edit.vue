<script setup lang="ts">
import { Form, Head } from '@inertiajs/vue3';
import { computed, ref } from 'vue';
import LineController from '@/actions/App/Http/Controllers/Admin/LineController';
import Heading from '@/components/Heading.vue';
import InputError from '@/components/InputError.vue';
import LineMap from '@/components/lines/LineMap.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Line } from '@/types/line';

const props = defineProps<{
    line: Line;
}>();

const geoJsonText = ref(
    props.line.geo_json ? JSON.stringify(props.line.geo_json, null, 2) : '',
);

const parsedGeoJson = computed(() => {
    if (!geoJsonText.value) {
        return null;
    }

    try {
        return JSON.parse(geoJsonText.value) as NonNullable<Line['geo_json']>;
    } catch {
        return null;
    }
});

const isEditingMap = ref(false);
const mode = ref<'move' | 'add' | 'delete'>('move');

const geoJsonError = ref<string | null>(null);

function toggleEditing(): void {
    if (isEditingMap.value) {
        mode.value = 'move';
    }

    isEditingMap.value = !isEditingMap.value;
}

function onMapUpdate(geoJson: NonNullable<Line['geo_json']>): void {
    geoJsonText.value = JSON.stringify(geoJson, null, 2);
    geoJsonError.value = null;
}

function validateGeoJson(): void {
    if (!geoJsonText.value) {
        geoJsonError.value = null;

        return;
    }

    try {
        JSON.parse(geoJsonText.value);
        geoJsonError.value = null;
    } catch {
        geoJsonError.value = 'Invalid JSON format.';
    }
}

const pageTitle = computed(
    () =>
        `Edit: ${props.line.code} — ${props.line.sense === 'OUTBOUND' ? 'Ida' : 'Vuelta'}`,
);
</script>

<template>
    <Head :title="pageTitle" />
    <Heading
        :title="pageTitle"
        description="Update line name, color, syndicate, or route geometry"
    />

    <div class="grid gap-8 lg:grid-cols-2">
        <!-- Form -->
        <div>
            <Form
                v-bind="LineController.update.form(line.id)"
                class="space-y-6"
                v-slot="{ errors, processing }"
            >
                <!-- Read-only fields -->
                <div class="grid gap-2">
                    <Label for="code">Code</Label>
                    <Input
                        id="code"
                        :model-value="line.code"
                        disabled
                        class="opacity-60"
                    />
                </div>

                <div class="grid gap-2">
                    <Label for="sense">Direction</Label>
                    <Input
                        id="sense"
                        :model-value="line.sense"
                        disabled
                        class="opacity-60"
                    />
                </div>

                <!-- Editable fields -->
                <div class="grid gap-2">
                    <Label for="name">Name</Label>
                    <Input
                        id="name"
                        name="name"
                        :default-value="line.name ?? ''"
                        placeholder="Line display name"
                    />
                    <InputError :message="errors.name" />
                </div>

                <div class="grid gap-2">
                    <Label for="color">Color</Label>
                    <div class="flex items-center gap-3">
                        <Input
                            id="color"
                            name="color"
                            :default-value="line.color ?? ''"
                            placeholder="#3b82f6"
                            class="w-32"
                        />
                        <span
                            v-if="line.color"
                            class="inline-block h-6 w-6 rounded"
                            :style="{ backgroundColor: line.color }"
                        />
                    </div>
                    <InputError :message="errors.color" />
                </div>

                <div class="grid gap-2">
                    <Label for="syndicate">Syndicate</Label>
                    <Input
                        id="syndicate"
                        name="syndicate"
                        :default-value="line.syndicate ?? ''"
                        placeholder="Operating company"
                    />
                    <InputError :message="errors.syndicate" />
                </div>

                <div class="grid gap-2">
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

                <div class="flex items-center gap-4">
                    <Button :disabled="processing">Save</Button>
                </div>
            </Form>
        </div>

        <!-- Map preview / editor -->
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <Label>Route preview</Label>
                <Button
                    v-if="parsedGeoJson"
                    type="button"
                    variant="outline"
                    size="sm"
                    @click="toggleEditing"
                >
                    {{ isEditingMap ? 'Finish editing' : 'Edit route on map' }}
                </Button>
            </div>
            <div v-if="isEditingMap" class="flex flex-wrap gap-2">
                <Button
                    type="button"
                    :variant="mode === 'move' ? 'default' : 'outline'"
                    size="sm"
                    @click="mode = 'move'"
                >
                    Move
                </Button>
                <Button
                    type="button"
                    :variant="mode === 'add' ? 'default' : 'outline'"
                    size="sm"
                    @click="mode = 'add'"
                >
                    Add vertex
                </Button>
                <Button
                    type="button"
                    :variant="mode === 'delete' ? 'default' : 'outline'"
                    size="sm"
                    @click="mode = 'delete'"
                >
                    Delete vertex
                </Button>
            </div>
            <LineMap
                :geo-json="parsedGeoJson"
                :editable="isEditingMap"
                :mode="mode"
                @update:geo-json="onMapUpdate"
            />
            <p
                v-if="isEditingMap"
                class="text-sm text-blue-600 dark:text-blue-500"
            >
                <template v-if="mode === 'move'">
                    Drag the white dots to adjust the route geometry.
                </template>
                <template v-else-if="mode === 'add'">
                    Click on the route to add a new vertex.
                </template>
                <template v-else> Click a vertex to delete it. </template>
            </p>
            <p
                v-if="!parsedGeoJson && geoJsonText"
                class="text-sm text-red-600 dark:text-red-500"
            >
                Fix JSON errors to see the route on the map.
            </p>
        </div>
    </div>
</template>

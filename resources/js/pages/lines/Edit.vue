<script setup lang="ts">
import { Form, Head, router } from '@inertiajs/vue3';
import {
    ArrowLeft,
    ArrowLeftRight,
    ArrowRightLeft,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    PencilLine,
    Redo2,
    RotateCcw,
    Shuffle,
    Undo2,
} from '@lucide/vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import LineController from '@/actions/App/Http/Controllers/Admin/LineController';
import Heading from '@/components/Heading.vue';
import InputError from '@/components/InputError.vue';
import DeleteLineDialog from '@/components/lines/DeleteLineDialog.vue';
import LineMap from '@/components/lines/LineMap.vue';
import RouteModePicker from '@/components/lines/RouteModePicker.vue';
import RouteStats from '@/components/lines/RouteStats.vue';
import { Button } from '@/components/ui/button';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { usePropagation } from '@/composables/usePropagation';
import { useResampleSpacing } from '@/composables/useResampleSpacing';
import { useRouteGeometry } from '@/composables/useRouteGeometry';
import { useSnapPreset } from '@/composables/useSnapPreset';
import { guidesFromGeometry, waypointsFromRecord } from '@/lib/guidedRouting';
import type { Waypoint } from '@/lib/guidedRouting';
import {
    describePropagationTooltip,
    describeSnapPreset,
    describeSnapTooltip,
    SNAP_PRESET_NAMES,
    snapOptionsFor,
} from '@/lib/routeEditing';
import type { SnapPreset } from '@/lib/routeEditing';
import {
    canRedo,
    canUndo,
    emptyHistory,
    isTextEntryTarget,
    record,
    redoStep,
    undoStep,
} from '@/lib/undoStack';
import lines from '@/routes/lines';
import type { DirectionOperation, Line, LineNav } from '@/types/line';

/**
 * The map, for the two things this page cannot know on its own.
 *
 * A template ref rather than a shared store because both are questions with a
 * single owner: whether a pending batch of anchors can be undone, and being
 * asked to undo it. Everything the map owns it answers for itself.
 */
const mapRef = ref<InstanceType<typeof LineMap> | null>(null);

/**
 * How many geometry states to keep. Deep enough to walk back through a whole
 * line, shallow enough that a route with 591 vertices does not pin a lot of
 * memory: 50 of them is well under a couple of megabytes.
 */
const UNDO_LIMIT = 50;

/**
 * How long typing has to pause before the GeoJSON is validated.
 *
 * Only the validation is deferred — never the state itself. Two things have to
 * stay immediate and it is worth saying why, because the tempting version of
 * this change batches all three and loses the reviewer's work:
 *
 * The dirty flag gates the unsaved-changes prompt. Set on a timer, a reviewer
 * who types and reaches for "Back to lines" inside the delay sails straight
 * out of the page with `isDirty` still false and no prompt ever appearing.
 *
 * The text itself feeds `parsedGeoJson`, which is what the map draws. Held back
 * for the delay, the map would keep showing the previous geometry while the
 * textarea shows the new one, and the two would disagree on screen.
 *
 * Both assignments are free — a ref write and a boolean. The parse is the only
 * part worth spending a timer on, so that is the only part that gets one.
 */
const GEOJSON_VALIDATE_DELAY = 300;

const props = defineProps<{
    line: Line;
    counterpart?: Pick<Line, 'id' | 'code' | 'sense'> | null;
    nav: LineNav;
    /** The stored control-point rows, null on a line with no recipe yet. */
    waypoints?:
        { ordinal: number; role: string; lat: number; lng: number }[] | null;
}>();

/**
 * The composable starts from empty text, so the line is loaded through the same
 * path the watcher below uses. Loading it here rather than seeding a ref keeps
 * one rule for what a loaded route looks like, instead of two that have to agree
 * about the JSON formatting and the error state.
 */
const {
    geoJsonText,
    parsedGeoJson,
    geoJsonError,
    isDirty,
    isEditingMap,
    mode,
    editToggleLabel,
    markDirty,
    replaceGeometry,
    setGeometry,
    validateGeoJson,
    toggleEditing,
    confirmDiscard,
} = useRouteGeometry();

replaceGeometry(props.line.geo_json);

/**
 * The control points the guided mode accepted, and the recipe the route's
 * editing sessions are made of.
 *
 * The server sends the stored recipe when the line has one; spec 4.1 boots
 * an existing route that carries only vertices from its own two ends. The
 * parent owns the list — it is what gets persisted and what the undo stack
 * restores alongside the geometry.
 */
const waypoints = ref<Waypoint[]>(
    waypointsFromRecord(props.waypoints ?? []).length > 0
        ? waypointsFromRecord(props.waypoints ?? [])
        : (guidesFromGeometry(props.line.geo_json?.coordinates) ?? []),
);

/**
 * Whether this visit actually touched the recipe.
 *
 * The form only carries the waypoints field when it did. Without the flag,
 * opening a line and saving it without touching the guided mode would write
 * the bootstrap's derived controls into the database — a recipe for a route
 * nobody authored, claiming a human chose those two endpoints on roads the
 * route may not even follow. Absent, the server leaves the stored rows
 * alone, which is exactly what a save above the guided mode should do.
 */
const waypointsTouched = ref(false);

/**
 * One state of an editing visit, whole.
 *
 * The geometry text and the control points are one entry in the history,
 * because a guided accept changes both and two parallel stacks would let
 * undo restore one half while the other still claimed the splice.
 */
interface GuidedState {
    geometry: string;
    waypoints: Waypoint[];
}

/**
 * Confirm an action that navigates away from the current line.
 *
 * The direction and refresh actions both go through Inertia, which replaces
 * the page and therefore throws away anything typed but not saved. The
 * unsaved-changes guard in confirmDiscard only covers deliberate navigation,
 * so without this the reviewer can edit a name, reach for "Invert directions"
 * and silently lose the edit.
 *
 * Deliberately a warning rather than disabling the buttons: hiding the
 * action leaves no visible reason why it cannot be used, and the reviewer has
 * no way to tell that is what happened.
 */
function confirmNavigation(message: string): boolean {
    if (isDirty.value) {
        return window.confirm(
            `${message}\n\nYou have unsaved edits on this form, and this will discard them.`,
        );
    }

    return window.confirm(message);
}

/**
 * Re-sync the editor when the server hands us a different line.
 *
 * Inertia reuses this component instance when navigating between two lines, so
 * setup does not run again and the textarea would keep the previous line's
 * geometry while the form action already pointed at the new line's id. Saving
 * would then write one line's geometry onto another.
 */
watch(
    () => props.line.geo_json,
    (geoJson) => {
        replaceGeometry(geoJson);

        // New geometry means a new route to undo edits on. Keeping the old
        // stack would offer a step that restores a shape that is no longer the
        // one being edited.
        history.value = emptyHistory();

        // And a new recipe to edit from — re-derived, never carried over from
        // the previous line, for the same reason the stack resets.
        waypoints.value =
            waypointsFromRecord(props.waypoints ?? []).length > 0
                ? waypointsFromRecord(props.waypoints ?? [])
                : (guidesFromGeometry(geoJson?.coordinates) ?? []);
        waypointsTouched.value = false;
    },
);

const canChangeDirection = computed(() => Boolean(props.counterpart));

/**
 * Whether the direction card is open.
 *
 * Local rather than shared because it is the only disclosure on the page and it
 * has nothing to coordinate with. Open by default on nothing: the card used to
 * be the first thing on screen and it was carrying fifty-six words for three
 * rarely-pressed buttons, so the reviewer paid that cost before seeing the map.
 */
const directionOpen = ref(false);

const directionActions: {
    operation: DirectionOperation;
    label: string;
    icon: typeof Shuffle;
    confirm: string;
}[] = [
    {
        operation: 'invert',
        label: 'Invert directions',
        icon: ArrowRightLeft,
        confirm:
            'Reverse the point order of both this line and its counterpart?\n\n' +
            'Each direction keeps its own streets; only the direction of travel flips. ' +
            'Running this again restores the previous geometry.',
    },
    {
        operation: 'swap',
        label: 'Swap routes',
        icon: Shuffle,
        confirm:
            'Swap the geometry between this line and its counterpart?\n\n' +
            'This direction will then trace the streets its counterpart used. ' +
            'Name, color and syndicate stay with the sense they describe. ' +
            'Running this again restores the previous geometry.',
    },
];

function applyDirection(
    operation: DirectionOperation,
    confirmMessage: string,
): void {
    if (!canChangeDirection.value) {
        return;
    }

    if (!confirmNavigation(confirmMessage)) {
        return;
    }

    router.patch(LineController.directions.url({ line: props.line.id }), {
        operation,
    });
}

function refreshGeometry(): void {
    const warning = props.line.geometry_adjusted
        ? 'This line carries a manual correction. Restoring the source geometry discards it.\n\n'
        : '';

    if (
        !confirmNavigation(
            `${warning}Restore "${props.line.code}" from the source GeoJSON?\n\n` +
                'Precomputed transfers for this line will hold stale point indexes.',
        )
    ) {
        return;
    }

    router.post(LineController.refreshGeometry.url({ line: props.line.id }));
}

/**
 * Undo/redo for geometry edits, scoped to this visit of this line.
 *
 * Not a version log: a direction change, a save, or navigating to another line
 * all reload the page and the history goes with them. The state it covers is
 * the one that actually needs a safety net — dragging a vertex by accident —
 * because nothing is written to the database until Save.
 *
 * Typing in the textarea is deliberately not recorded. A keystroke would be an
 * entry, and the browser's own text undo already covers it, both because it is
 * better and because the stack would fill up with noise within seconds.
 */
const history = ref(emptyHistory<GuidedState>());

/**
 * Tells the map to keep its framing for the change about to happen.
 *
 * The map refits the route into view whenever the geometry changes, which is
 * right after a drag and wrong after an undo: the reviewer is looking at a
 * detail they just zoomed to, and a refit is thrown away at the moment they are
 * trying to see what the undo did. Incrementing a counter rather than setting a
 * flag is what makes it apply once — see the note on the map's side.
 */
const preserveViewToken = ref(0);

function undo(): void {
    // A pending batch of anchors is the most recent edit while one exists, and
    // undo means the most recent edit. The map owns it, so it is asked first.
    if (mapRef.value?.undoPendingAnchors() === true) {
        return;
    }

    const step = undoStep(history.value, {
        geometry: geoJsonText.value,
        waypoints: waypoints.value,
    });

    if (step.value === null) {
        return;
    }

    history.value = step.history;
    geoJsonText.value = step.value.geometry;
    waypoints.value = step.value.waypoints;
    preserveViewToken.value += 1;
    markDirty();
}

function redo(): void {
    if (mapRef.value?.redoPendingAnchors() === true) {
        return;
    }

    const step = redoStep(history.value, {
        geometry: geoJsonText.value,
        waypoints: waypoints.value,
    });

    if (step.value === null) {
        return;
    }

    history.value = step.history;
    geoJsonText.value = step.value.geometry;
    waypoints.value = step.value.waypoints;
    preserveViewToken.value += 1;
    markDirty();
}

/**
 * What a pending-batch step would do, as the map reports it.
 *
 * Held here only so the undo button can answer, and OR'd into the disabled
 * state: a greyed Undo sitting next to three placed anchors is what made the
 * reviewer conclude that undo did not work.
 */
const pendingUndo = ref({ canUndo: false, canRedo: false });

function onPendingUndo(state: { canUndo: boolean; canRedo: boolean }): void {
    pendingUndo.value = state;
}

const canUndoGeometry = computed(
    () => canUndo(history.value) || pendingUndo.value.canUndo,
);
const canRedoGeometry = computed(
    () => canRedo(history.value) || pendingUndo.value.canRedo,
);

/**
 * What Undo is about to take back, said where the button is.
 *
 * Two destinations behind one button, and a tooltip that named only the older
 * one would be wrong every time the newer was what a press would undo.
 */
const undoTooltip = computed(() =>
    pendingUndo.value.canUndo
        ? 'Takes back the last anchor you placed (Ctrl+Z). Press it again to go further back.'
        : 'Undo the last geometry edit (Ctrl+Z). The map keeps its framing, so you stay where you were looking.',
);

const { snapPreset, updateSnapPreset } = useSnapPreset();
const { propagationEnabled, updatePropagation } = usePropagation();
const { resampleSpacing, updateResampleSpacing } = useResampleSpacing();

/**
 * What the snap will do with a drop, in detail.
 *
 * A tooltip on the preset rather than a paragraph under it. The distance that
 * decides whether a drop snaps at all is printed on the control itself, and what
 * is left to say is the part a reviewer needs *after* something went somewhere
 * unexpected — chiefly the crossing rule, which only becomes observable at an
 * intersection and is useless until then.
 */
const snapTooltip = computed(() => describeSnapTooltip(snapPreset.value));

/**
 * What propagation does around a drop.
 *
 * Both limits come from the snap's own threshold rather than a second figure, so
 * the checkbox cannot appear to disagree with the select about how far a vertex
 * has to be to count as on the street.
 */
const propagationTooltip = computed(() => {
    const options = snapOptionsFor(snapPreset.value);

    return describePropagationTooltip(options?.threshold ?? 0);
});

/**
 * Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, deferring to the browser's own text undo
 * whenever the caret is in a field.
 *
 * A global handler that also fired inside the textarea would fight the native
 * behaviour, and the two together are worse than either alone: the field would
 * undo text while the map looked frozen.
 *
 * `defaultPrevented` is the other deferral: the map claims the same keys while a
 * batch of anchors is half placed, because undo means "take that back" there and
 * this handler would otherwise undo the last edit the reviewer ACCEPTED. Whichever
 * listener runs first wins and the other stands down, so neither depends on
 * which of them registered its listener first.
 */
function handleKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || (!e.metaKey && !e.ctrlKey)) {
        return;
    }

    if (isTextEntryTarget(e.target)) {
        return;
    }

    const key = e.key.toLowerCase();

    if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
    }
}

/**
 * The pending validation, or null when none is scheduled.
 *
 * A plain `let` rather than a ref on purpose: this is not state anything
 * renders, and the page is server-rendered, so a ref would only be a value
 * that has to be reasoned about during SSR for no benefit.
 */
let geoJsonValidateTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingValidation(): void {
    if (geoJsonValidateTimer) {
        clearTimeout(geoJsonValidateTimer);
        geoJsonValidateTimer = null;
    }
}

/**
 * Take a keystroke into the geometry field.
 *
 * The state moves now and the parse happens once the reviewer stops, so the
 * map and the textarea never disagree and the unsaved-changes guard is already
 * armed by the time anyone can navigate.
 */
function onGeoJsonInput(event: Event): void {
    geoJsonText.value = (event.target as HTMLTextAreaElement).value;
    markDirty();

    cancelPendingValidation();
    geoJsonValidateTimer = setTimeout(() => {
        geoJsonValidateTimer = null;
        validateGeoJson();
    }, GEOJSON_VALIDATE_DELAY);
}

onMounted(() => {
    document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown);
    cancelPendingValidation();
});

/**
 * Take geometry from the map, recording what it replaced.
 *
 * The only part of this page's map handling that is not shared with the create
 * page, and it is here rather than in the composable because the history belongs
 * to this visit of this line: the create page has nothing to undo.
 */
function onMapUpdate(
    geoJson: NonNullable<Line['geo_json']>,
    meta?: { snap?: boolean; propagated?: number; laid?: boolean },
): void {
    // A snap is the tool refining a move the reviewer already made, not a
    // second move. Recording it would put "drag the vertex" and "pull it onto the
    // street" in the history as separate steps, so the first undo would
    // appear to do nothing and the second would take back the move itself.
    //
    // Propagation is the exception that proves why that rule needs saying out
    // loud. It moves vertices the reviewer never grabbed, which makes it a second
    // move by any honest reading — and leaving it unrecorded is not merely a
    // missing undo step. Undo would restore the pre-drag geometry and so discard
    // the propagation as a side effect, but redo replays the state the drag
    // produced, which is the state *without* it. A reviewer who undid a four
    // vertex pull to see what it did and then redid it would come back to a
    // different route than the one they were looking at, with nothing on screen
    // to say so. Recording it costs one history entry and makes the round trip
    // an identity.
    //
    // A lay is recorded for the same reason and a stronger one: it replaced the
    // shape the reviewer dragged with the shape of a street, and it may have
    // removed vertices outright. Every vertex it moved was the reviewer's own,
    // which is why it needs its own flag rather than a count — but a stretch that
    // comes back different from the one that was dragged, with fewer vertices than
    // it started with, is exactly the thing an undo stack exists to be able to
    // take back.
    const isSecondMove = (meta?.propagated ?? 0) > 0 || meta?.laid === true;

    if (!meta?.snap || isSecondMove) {
        history.value = record(
            history.value,
            { geometry: geoJsonText.value, waypoints: waypoints.value },
            UNDO_LIMIT,
        );
    }

    setGeometry(geoJson);
}

/**
 * A guided result in, both halves stored after the old state is recorded.
 *
 * The record happens BEFORE either assignment, so the composite entry is the
 * state this visit actually held — assigning geometry first would push a
 * half-state (new geometry, old controls) and undo would restore that lie.
 *
 * The framing is preserved for the same reason it is for an undo: the control
 * point the reviewer just placed is the click they were looking at, so a refit
 * can only take away the detail they chose. Without this the map refits the
 * whole route on every accepted tramo and the reviewer loses their place.
 */
function onGuidedUpdate(payload: {
    coordinates: NonNullable<Line['geo_json']>['coordinates'] | null;
    waypoints: Waypoint[];
}): void {
    history.value = record(
        history.value,
        { geometry: geoJsonText.value, waypoints: waypoints.value },
        UNDO_LIMIT,
    );

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

/**
 * "Ida" or "Vuelta" for a sense value.
 *
 * The ternary was written out four times in this file, and the two versions
 * that matter to a reviewer — this line's and its counterpart's — sit nine
 * lines apart in the header. One function is the only place where the word
 * for a sense is decided.
 */
function senseName(sense: Line['sense']): string {
    return sense === 'OUTBOUND' ? 'Ida' : 'Vuelta';
}

const senseLabel = computed(() => senseName(props.line.sense));

const pageTitle = computed(
    () => `Edit: ${props.line.code} — ${senseLabel.value}`,
);

/**
 * The icon that goes with the editor toggle, flipped by the same state.
 *
 * Data rather than two branches of markup so the glyph can never describe the
 * opposite of the label next to it.
 */
const editToggleIcon = computed(() =>
    isEditingMap.value ? Check : PencilLine,
);

/**
 * The recipe as the form posts it — only when this visit touched it.
 *
 * Flat {lat, lng} objects, the exact shape WaypointsPayload validates and
 * syncWaypoints consumes; ordinal and role are server-derived, so they
 * deliberately do not travel.
 */
const waypointsField = computed<string | null>(() => {
    // An empty list posts as '[]' and that is not the same as an absent field:
    // WaypointsPayload validates [] and syncWaypoints([]) deletes the rows, which
    // is how a recipe whose last control was just removed actually reaches the
    // database instead of coming back on the next load. Returning null for an
    // empty list here would read as "this save touched no controls" and leave the
    // stored rows alone.
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
</script>

<template>
    <Head :title="pageTitle" />
    <div class="flex items-center justify-between">
        <Button
            type="button"
            variant="ghost"
            size="sm"
            class="-ml-3"
            @click="confirmDiscard(lines.index.url())"
        >
            <ArrowLeft class="size-4" />
            Back to lines
        </Button>

        <div class="flex items-center gap-2">
            <!--
                Every navigation control here moved to a shadcn Tooltip instead
                of a native title. Two reasons, and the second is the real one: a
                Button is `disabled:pointer-events-none`, so a title on a
                disabled button never fires — and the pager is disabled at the
                ends of the list, which is exactly when the reviewer is checking
                whether there is a line that way. A Tooltip triggered from a
                wrapper span has neither problem.
            -->
            <TooltipProvider :delay-duration="0">
                <Tooltip v-if="props.counterpart">
                    <TooltipTrigger as-child>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            @click="
                                confirmDiscard(
                                    lines.edit.url({
                                        line: props.counterpart!.id,
                                    }),
                                )
                            "
                        >
                            <ArrowLeftRight class="size-4" />
                            {{ senseName(props.counterpart.sense) }}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs">
                        <p>
                            {{
                                `Switch to ${props.counterpart.code} (${senseName(
                                    props.counterpart.sense,
                                )})`
                            }}
                        </p>
                    </TooltipContent>
                </Tooltip>

                <!--
                    A pager, so it reads as a pair and stays a pair. Icon-only
                    because "Previous" and "Next" cost two words each to say
                    something the chevrons already say, and the code they jump
                    to — the part that is not obvious — is in the tooltip.
                -->
                <Tooltip v-if="props.nav.prev">
                    <TooltipTrigger as-child>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            @click="
                                confirmDiscard(
                                    lines.edit.url({
                                        line: props.nav.prev!.id,
                                    }),
                                )
                            "
                        >
                            <ChevronLeft class="size-4" />
                            <span class="sr-only">Previous line</span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs">
                        <p>Previous: {{ props.nav.prev.code }}</p>
                    </TooltipContent>
                </Tooltip>

                <Tooltip v-if="props.nav.next">
                    <TooltipTrigger as-child>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            @click="
                                confirmDiscard(
                                    lines.edit.url({
                                        line: props.nav.next!.id,
                                    }),
                                )
                            "
                        >
                            <span class="sr-only">Next line</span>
                            <ChevronRight class="size-4" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs">
                        <p>Next: {{ props.nav.next.code }}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        </div>
    </div>
    <Heading :title="pageTitle" />

    <div class="grid gap-8 lg:grid-cols-3">
        <!-- Form -->
        <div class="space-y-4 lg:col-span-1">
            <Form
                v-bind="LineController.update.form(line.id)"
                class="grid grid-cols-2 gap-4"
                v-slot="{ errors, processing }"
            >
                <!--
                    Read-only, and printed rather than shown as disabled
                    inputs.

                    A disabled control is a poor way to say "not editable": it
                    occupies the space a real field would, it takes focus in
                    the tab order, it cannot be selected with the mouse without
                    a keyboard dance to get the value out, and it invites the
                    reviewer to type into it and watch nothing happen. Two of
                    the four are bugs and one is a lie.

                    A plain definition row says the same thing and also frames
                    what follows: this is the record being changed, and
                    everything under it is what can be changed about it.
                -->
                <dl
                    class="col-span-2 grid grid-cols-2 gap-4 rounded-md border bg-muted/40 px-3 py-2"
                >
                    <div class="grid gap-0.5">
                        <dt class="text-xs font-medium text-muted-foreground">
                            Code
                        </dt>
                        <dd class="font-mono text-sm">{{ line.code }}</dd>
                    </div>
                    <div class="grid gap-0.5">
                        <dt class="text-xs font-medium text-muted-foreground">
                            Direction
                        </dt>
                        <dd class="text-sm">
                            {{ senseLabel }}
                            <span class="text-muted-foreground">
                                ({{ line.sense }})
                            </span>
                        </dd>
                    </div>
                </dl>

                <!-- Editable fields -->
                <div class="col-span-2 grid gap-1">
                    <Label for="name">Name</Label>
                    <Input
                        id="name"
                        name="name"
                        :default-value="line.name ?? ''"
                        placeholder="Line display name"
                        @input="markDirty"
                    />
                    <InputError :message="errors.name" />
                    <p class="text-sm text-muted-foreground">
                        What riders read on the bus. For a slug code, this is
                        the only wording the app shows.
                    </p>
                </div>

                <!--
                    Full width now that the identity row above takes its own
                    line: these two were sharing half the form with the name
                    field, which left three inputs on one row and made the
                    name the odd one out.
                -->
                <div class="col-span-2 grid grid-cols-2 gap-4">
                    <div class="grid gap-2">
                        <Label for="color">Color</Label>
                        <div class="flex items-center gap-3">
                            <Input
                                id="color"
                                name="color"
                                :default-value="line.color ?? ''"
                                placeholder="#3b82f6"
                                class="w-32"
                                @input="markDirty"
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
                        @input="onGeoJsonInput"
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

                <!--
                    Cancel is gone, and "Back to lines" at the top of the page
                    was already it: same href, same confirmDiscard, same guard
                    against throwing away unsaved geometry. Two buttons for one
                    action meant one of them was the one the reviewer reached
                    for and the other was the one they second-guessed.

                    What replaced it is the reason they used to need Cancel to
                    discover. isDirty was set on every keystroke and every
                    vertex drag but stayed invisible until someone tried to
                    leave and got a confirm() — so the state existed only at
                    the moment it stopped being recoverable. Printed next to
                    Save, it is visible while it is still cheap to act on.
                -->
                <div class="col-span-2 flex items-center gap-4">
                    <Button :disabled="processing">Save</Button>
                    <span
                        v-if="isDirty"
                        class="text-sm font-medium text-amber-700 dark:text-amber-400"
                    >
                        Unsaved changes
                    </span>
                </div>
                <!--
                    The guided editor's control-point recipe. Posted only when
                    this visit actually changed it (see waypointsTouched), so a
                    save above the guided mode never overwrites the stored
                    recipe with the §4.1 bootstrap.
                -->
                <input
                    v-if="waypointsField !== null"
                    type="hidden"
                    name="waypoints"
                    :value="waypointsField"
                />
            </Form>
        </div>

        <!-- Map preview / editor -->
        <div class="space-y-4 lg:col-span-2">
            <!--
                Collapsed, and the reason is volume rather than tidiness. This
                card was carrying fifty-six words of prose for three buttons that
                are rarely pressed — it out-weighed the entire map toolbar above,
                while being about the line rather than about its geometry. The
                trigger row keeps both badges visible, because the state is what a
                reviewer has to see without opening anything.
            -->
            <Collapsible v-model:open="directionOpen" class="rounded-md border">
                <CollapsibleTrigger
                    class="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                    <span class="flex items-center gap-2">
                        <Label>Direction</Label>
                        <span
                            v-if="props.line.geometry_adjusted"
                            class="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        >
                            Manually corrected
                        </span>
                        <!--
                            On the trigger rather than inside the panel, and that
                            placement is not cosmetic. The two direction buttons are
                            disabled without a counterpart, and the codebase has
                            already written down why that reason cannot live
                            behind a disclosure: hiding the action must not hide
                            the reason it cannot be used.
                        -->
                        <span
                            v-if="!canChangeDirection"
                            class="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                            No counterpart
                        </span>
                    </span>
                    <ChevronDown
                        class="size-4 shrink-0 text-muted-foreground transition-transform"
                        :class="{ 'rotate-180': directionOpen }"
                    />
                </CollapsibleTrigger>
                <CollapsibleContent class="px-4 pb-4">
                    <!--
                        The paragraph explains what the two buttons are for, so
                        it is only rendered when there are two buttons that can
                        do it. It used to print above a row of dead controls,
                        which is how a line with no counterpart ended up
                        reading forty words about re-orienting and then saying
                        it could not be re-oriented.
                    -->
                    <p
                        v-if="canChangeDirection"
                        class="text-sm text-muted-foreground"
                    >
                        The source data does not record which end a bus departs
                        from, so this is a manual correction. Both actions cover
                        this line and its counterpart, and both are undone by
                        repeating them.
                    </p>
                    <div
                        class="flex flex-wrap gap-2"
                        :class="canChangeDirection ? 'mt-3' : ''"
                    >
                        <!--
                            The trigger is a span around the button, because the
                            reason a button is disabled is exactly when the
                            explanation is wanted and a disabled button fires
                            no pointer events for a title to hang off.
                        -->
                        <TooltipProvider :delay-duration="0">
                            <Tooltip
                                v-for="action in directionActions"
                                :key="action.operation"
                            >
                                <TooltipTrigger as-child>
                                    <span class="inline-flex">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            :disabled="!canChangeDirection"
                                            @click="
                                                applyDirection(
                                                    action.operation,
                                                    action.confirm,
                                                )
                                            "
                                        >
                                            <component
                                                :is="action.icon"
                                                class="size-4"
                                            />
                                            {{ action.label }}
                                        </Button>
                                    </span>
                                </TooltipTrigger>
                                <!--
                                    Rendered only while the button is disabled.
                                    What the button does is a confirm() the
                                    reviewer has to answer anyway, so the
                                    tooltip has one job — say why it cannot be
                                    pressed — and showing it unconditionally
                                    would have it deny the existence of a
                                    counterpart on the lines that have one.
                                -->
                                <TooltipContent
                                    v-if="!canChangeDirection"
                                    class="max-w-xs"
                                >
                                    <p>
                                        This line has no counterpart to
                                        re-orient.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <TooltipProvider :delay-duration="0">
                            <Tooltip>
                                <TooltipTrigger as-child>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        @click="refreshGeometry"
                                    >
                                        <RotateCcw class="size-4" />
                                        Reset to source
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent class="max-w-xs">
                                    <p>
                                        Restore this line's geometry from the
                                        source GeoJSON.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <!--
                            Pushed to the far end of the row, because this is
                            the one button on the page that cannot be taken
                            back and it should not sit shoulder to shoulder
                            with two that can. It lives in this card for the
                            same reason Reset to source does: it is an
                            operation on the record rather than on the form,
                            and this is the card that holds those.
                        -->
                        <div class="sm:ml-auto">
                            <DeleteLineDialog
                                :line="line"
                                :has-counterpart="Boolean(props.counterpart)"
                                :has-unsaved-edits="isDirty"
                            />
                        </div>
                    </div>
                    <p
                        v-if="!canChangeDirection"
                        class="mt-2 text-sm text-muted-foreground"
                    >
                        A line with no counterpart cannot be re-oriented.
                        Circular routes such as 72 and 73 are legitimately alone
                        in their direction. Reset to source still applies.
                    </p>
                </CollapsibleContent>
            </Collapsible>

            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <Label>Route preview</Label>
                    <RouteStats :geo-json="parsedGeoJson" />
                </div>
                <div class="flex items-center gap-2">
                    <!--
                        Icon-only with a Tooltip, and the tooltip is doing
                        real work rather than repeating a visible word: the
                        reason the map keeps its framing after an undo is the
                        thing a reviewer needs to know before pressing it, and
                        a native title would have hidden it behind a hover
                        delay on a control that is disabled precisely when
                        there is nothing to undo.
                    -->
                    <TooltipProvider :delay-duration="0">
                        <Tooltip v-if="isEditingMap">
                            <TooltipTrigger as-child>
                                <span class="inline-flex">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        :disabled="!canUndoGeometry"
                                        @click="undo"
                                    >
                                        <Undo2 class="size-4" />
                                        <span class="sr-only">Undo</span>
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent class="max-w-xs">
                                <p>{{ undoTooltip }}</p>
                            </TooltipContent>
                        </Tooltip>

                        <Tooltip v-if="isEditingMap">
                            <TooltipTrigger as-child>
                                <span class="inline-flex">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        :disabled="!canRedoGeometry"
                                        @click="redo"
                                    >
                                        <Redo2 class="size-4" />
                                        <span class="sr-only">Redo</span>
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent class="max-w-xs">
                                <p v-if="pendingUndo.canRedo">
                                    Puts the anchors back (Ctrl+Shift+Z).
                                </p>
                                <p v-else>Redo (Ctrl+Shift+Z)</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    <!--
                        The one control here that keeps its label. It is the
                        only way into the editor and it renames itself three
                        ways depending on state, so the glyph is a second signal
                        rather than a replacement for it.
                    -->
                    <Button
                        v-if="parsedGeoJson"
                        type="button"
                        variant="outline"
                        size="sm"
                        @click="toggleEditing"
                    >
                        <component :is="editToggleIcon" class="size-4" />
                        {{ editToggleLabel }}
                    </Button>
                </div>
            </div>
            <LineMap
                ref="mapRef"
                :geo-json="parsedGeoJson"
                :editable="isEditingMap"
                :mode="mode"
                :guided-waypoints="waypoints"
                :snap-preset="snapPreset"
                :relay="snapPreset !== 'off'"
                :resample="true"
                :resample-spacing="resampleSpacing"
                :preserve-view-token="preserveViewToken"
                @update:geo-json="onMapUpdate"
                @update:guided="onGuidedUpdate"
                @update:pending-undo="onPendingUndo"
                @update:resample-spacing="updateResampleSpacing"
            >
                <!--
                    Handed to the map rather than rendered beside it, so the mode
                    picker, the settings and the action buttons all land in one
                    toolbar above the map. The map holds the selection state the
                    actions act on, and a toolbar that was half in the page and
                    half in the map is how they end up on opposite sides of the
                    thing they control.
                -->
                <template #toolbar>
                    <RouteModePicker v-if="isEditingMap" v-model="mode">
                        <div
                            v-if="mode === 'move'"
                            class="flex flex-wrap items-center gap-4"
                        >
                            <!--
                                The threshold is on the control rather than in a
                                paragraph under it. "Normal" alone says nothing
                                about whether a drop will snap, which is why there
                                used to be fifty-eight words explaining what the
                                preset would do � and why they could never be
                                removed, since the reviewer had nowhere else to
                                find the number.
                            -->
                            <div class="flex items-center gap-2">
                                <Label for="snap-preset">Snap</Label>
                                <TooltipProvider :delay-duration="0">
                                    <Tooltip>
                                        <TooltipTrigger as-child>
                                            <span class="inline-flex">
                                                <select
                                                    id="snap-preset"
                                                    :value="snapPreset"
                                                    class="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                                                    @change="
                                                        updateSnapPreset(
                                                            (
                                                                $event.target as HTMLSelectElement
                                                            )
                                                                .value as SnapPreset,
                                                        )
                                                    "
                                                >
                                                    <option
                                                        v-for="preset in SNAP_PRESET_NAMES"
                                                        :key="preset"
                                                        :value="preset"
                                                    >
                                                        {{
                                                            describeSnapPreset(
                                                                preset,
                                                            )
                                                        }}
                                                    </option>
                                                </select>
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent class="max-w-xs">
                                            <p>{{ snapTooltip }}</p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            </div>

                            <!--
                                A checkbox rather than another preset value, and
                                gated on snapping being on at all: with the preset
                                at "off" there is no street for a drop to be pulled
                                onto, so leaving the box ticked would be a setting
                                that says it is doing something when it provably
                                is not.
                            -->
                            <div
                                v-if="snapPreset !== 'off'"
                                class="flex items-center gap-2"
                            >
                                <TooltipProvider :delay-duration="0">
                                    <Tooltip>
                                        <TooltipTrigger as-child>
                                            <span class="inline-flex">
                                                <input
                                                    id="snap-propagate"
                                                    type="checkbox"
                                                    class="size-4 rounded border-input accent-primary"
                                                    :checked="
                                                        propagationEnabled
                                                    "
                                                    @change="
                                                        updatePropagation(
                                                            (
                                                                $event.target as HTMLInputElement
                                                            ).checked,
                                                        )
                                                    "
                                                />
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent class="max-w-xs">
                                            <p>{{ propagationTooltip }}</p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                                <Label for="snap-propagate" class="font-normal">
                                    Snap nearby points to same street
                                </Label>
                            </div>
                        </div>
                    </RouteModePicker>
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

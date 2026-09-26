export type LineSense = 'OUTBOUND' | 'RETURN';

export type DirectionOperation = 'invert' | 'swap';

export interface Line {
    id: number;
    code: string;
    name: string | null;
    color: string | null;
    geo_json: {
        type: 'MultiLineString';
        coordinates: number[][][];
    } | null;
    geometry_adjusted: boolean;
    sense: LineSense;
    syndicate: string | null;
    objectid: number | null;
    parent_line_id: number | null;
    average_rating: number | null;
    total_reviews: number;
    created_at: string | null;
    updated_at: string | null;
    /**
     * The record holding the opposite direction, resolved by code and sense.
     * Null for a line that is alone in its direction, such as circular routes
     * 72 and 73 — which is exactly when the direction actions are unavailable.
     */
    counterpart?: Pick<Line, 'id' | 'code' | 'sense'> | null;
}

export interface LineNav {
    prev: Pick<Line, 'id' | 'code' | 'sense'> | null;
    next: Pick<Line, 'id' | 'code' | 'sense'> | null;
}

export interface LineFilters {
    search?: string;
    sense?: string;
}

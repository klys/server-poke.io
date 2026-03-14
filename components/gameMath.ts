
/**
 * Calculates the direction (in degrees) from point 1 to point 2.
 * @param x1 - The x coordinate of the first point.
 * @param y1 - The y coordinate of the first point.
 * @param x2 - The x coordinate of the second point.
 * @param y2 - The y coordinate of the second point.
 * @returns The angle in degrees.
 */
export function point_direction (x1:number,y1:number,x2:number,y2:number): number {
    const p1 = {
        x:x1,
        y:y1
    }
    const p2 = {
        x:x2,
        y:y2
    }
    return (calculate_angle(p1.x,p1.y,p2.x,p2.y)*180)/Math.PI
}

/**
 * Calculates the angle (in radians) from point 1 to point 2 based on quadrants.
 * @param x1 - The x coordinate of the first point.
 * @param y1 - The y coordinate of the first point.
 * @param x2 - The x coordinate of the second point.
 * @param y2 - The y coordinate of the second point.
 * @returns The angle in radians.
 */
export function calculate_angle(x1:number,y1:number,x2:number,y2:number): number {
    const p1 = {
        x:x1,
        y:y1
    }
    const p2 = {
        x:x2,
        y:y2
    }
    if (p2.x > p1.x) {
        // quad 1 or 2
        if (p2.y > p1.y) {
            // quad 2
            return arctan(p1.x,p1.y,p2.x,p2.y)}
            // should be 1-90
        else {
            if (p2.y==p1.y) {
                return 0}
            else {
                // quad 1
                return 2*Math.PI+arctan(p1.x,p1.y,p2.x,p2.y)
                // 270-360
            }
        }
    }
    else {    
        if (p2.x==p1.x) {
            // atan undefined
            if (p2.y == p1.y) {
                return 0}
            else {
                if (p2.y > p1.y) {
                    return Math.PI/2}
                else {
                    return 1.5*Math.PI
                }
            }
        }
        else {
            // else { p2.x < p1.x
            // quad 3 or 4
            if (p2.y == p1.y) {
                return Math.PI}
            else {
                if (p2.y > p1.y) {
                    // quad 3
                    return Math.PI + arctan(p1.x,p1.y,p2.x,p2.y)
                }
                    // 90-180
                else {
                    // quad 4
                    return Math.PI+ arctan(p1.x,p1.y,p2.x,p2.y)
                    // 180-270
                }
            }
        }
    }
}

/**
 * Returns the arc tangent of the line passing through points p1 and p2.
 * @param x1 - The x coordinate of the first point.
 * @param y1 - The y coordinate of the first point.
 * @param x2 - The x coordinate of the second point.
 * @param y2 - The y coordinate of the second point.
 * @returns The angle in radians.
 */
export function arctan (x1:number,y1:number,x2:number,y2:number): number {
    // Returns the arcTan of points p1 and p2.
    const p1 = {
        x:x1,
        y:y1
    }
    const p2 = {
        x:x2,
        y:y2
    }
    let rat=  (p2.y-p1.y)/(p2.x-p1.x)
    let inradians=Math.atan(rat)
    //indegrees=180*inradians/Math.PI
    return inradians
}

/**
 * Calculates the new position after moving a specified distance at a specific angle.
 * @param x - The starting x coordinate.
 * @param y - The starting y coordinate.
 * @param angle - The angle of movement in degrees.
 * @param distance - The distance to move.
 * @returns An object containing the newly calculated x and y coordinates.
 */
export function polar_move (x:number, y:number,angle:number,distance:number):any {
    return {
        x:Math.ceil(x + distance * Math.cos(angle * Math.PI / 180) ),
        y:Math.ceil(y + distance * Math.sin(angle * Math.PI / 180) ) 
    }
};

/**
 * Checks if two rectangular objects are colliding.
 * @param rect1 - The first rectangular object with x, y, width, and height.
 * @param rect2 - The second rectangular object with x, y, width, and height.
 * @returns True if they overlap/collide, false otherwise.
 */
export function collision_square(rect1:any,rect2:any):boolean {
    console.log("rect1:",rect1)
    console.log("rect2",rect2)
    return (rect1.x < rect2.x + rect2.width &&
        rect1.x + rect1.width > rect2.x &&
        rect1.y < rect2.y + rect2.height &&
        rect1.height + rect1.y > rect2.y) ? true : false;
}
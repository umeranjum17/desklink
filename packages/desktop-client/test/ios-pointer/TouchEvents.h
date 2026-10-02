#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN
@interface XCPointerEventPath : NSObject
- (instancetype)initForTouchAtPoint:(CGPoint)point offset:(double)offset NS_SWIFT_NAME(init(touch:offset:));
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset NS_SWIFT_NAME(move(to:at:));
- (void)liftUpAtOffset:(double)offset NS_SWIFT_NAME(lift(at:));
@end

@interface XCSynthesizedEventRecord : NSObject
- (instancetype)initWithName:(NSString *)name interfaceOrientation:(UIInterfaceOrientation)orientation;
- (void)addPointerEventPath:(XCPointerEventPath *)path;
- (BOOL)synthesizeWithError:(NSError * _Nullable * _Nullable)error;
@end
NS_ASSUME_NONNULL_END

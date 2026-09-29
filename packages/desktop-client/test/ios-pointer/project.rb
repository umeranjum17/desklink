# Writes DesklinkPointer.xcodeproj next to this file: a UI test bundle and the
# host app it needs. Run with CocoaPods' Ruby, which carries the xcodeproj gem.
require 'xcodeproj'

dir = __dir__
project = Xcodeproj::Project.new(File.join(dir, 'DesklinkPointer.xcodeproj'))
host = project.new_target(:application, 'PointerHost', :ios, '15.1')
host.add_file_references([project.main_group.new_file(File.join(dir, 'PointerHost.swift'))])
tests = project.new_target(:ui_test_bundle, 'PointerTests', :ios, '15.1')
tests.add_file_references([project.main_group.new_file(File.join(dir, 'PointerTests.swift'))])
tests.add_dependency(host)

{ host => 'dev.desklink.pointerhost', tests => 'dev.desklink.pointertests' }.each do |target, id|
  target.build_configurations.each do |config|
    config.build_settings.merge!(
      'PRODUCT_BUNDLE_IDENTIFIER' => id,
      'GENERATE_INFOPLIST_FILE' => 'YES',
      'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
      'SWIFT_VERSION' => '5.0',
      'TARGETED_DEVICE_FAMILY' => '1,2',
      'CODE_SIGN_STYLE' => 'Manual',
      'CODE_SIGN_IDENTITY' => '-',
    )
    config.build_settings['TEST_TARGET_NAME'] = 'PointerHost' if target == tests
  end
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(host)
scheme.add_test_target(tests)
scheme.save_as(project.path, 'PointerTests', true)

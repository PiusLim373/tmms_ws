from setuptools import find_packages, setup

package_name = 'navplan_processor'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='piuslim373',
    maintainer_email='piuslim373@gmail.com',
    description='Validates operator navigation plans and forwards them to the navigation state machine',
    license='TODO: License declaration',
    extras_require={
        'test': [
            'pytest',
        ],
    },
    entry_points={
        'console_scripts': [
            'navplan_processor_node = navplan_processor.navplan_processor_node:main'
        ],
    },
)
